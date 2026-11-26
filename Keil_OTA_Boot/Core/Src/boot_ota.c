/*
 * Bootloader-side serial OTA receiver.
 *
 * This is the same 0x7E-framed protocol the application used to implement,
 * moved into the bootloader so an update works even when the application is
 * missing or broken:
 *
 *   0x7E | TYPE | SEQ | LEN(2, LE) | PAYLOAD | CRC16(2, LE) | 0x7E
 *   0x7E escaped as 0x7D 0x5E, 0x7D as 0x7D 0x5D.
 *   CRC16 = CCITT-FALSE (poly 0x1021, init 0xFFFF) over TYPE..PAYLOAD.
 *
 * COBS-style framing is not used; the host waits for an ACK after every
 * START/DATA/END frame, so the UART can be polled directly: all bytes of a
 * frame have already arrived before flash programming starts.
 *
 * The image is written to the secondary slot, checked against CRC32,
 * SHA-256 and the MCUboot header magic, then marked pending. Signature
 * validation and the actual swap stay in MCUboot (boot_go).
 *
 * Protocol v2: QUERY returns a 40-byte STATUS frame with protocol/boot
 * versions, device UID, slot size and swap state. EXIT leaves the normal
 * application-requested OTA window so the host can verify the running image
 * after an upgrade without waiting for the idle timeout.
 */
#include <string.h>

#include "boot_ota.h"
#include "main.h"
#include "usart.h"
#include "flash_map_backend/flash_map_backend.h"
#include "sysflash/sysflash.h"
#include "bootutil/bootutil_public.h"
#include "tinycrypt/sha256.h"
#include "mcuboot_config/mcuboot_logging.h"

/* ---------------------------------------------------------------------- */
/* Protocol constants (must match the host)                               */
/* ---------------------------------------------------------------------- */
#define OTA_SOF                 0x7E
#define OTA_ESC                 0x7D
#define OTA_ESC_XOR             0x20

/* Host -> device */
#define OTA_FRAME_START         0x01
#define OTA_FRAME_DATA          0x02
#define OTA_FRAME_END           0x03
#define OTA_FRAME_APPLY         0x04
#define OTA_FRAME_ABORT         0x05
#define OTA_FRAME_QUERY         0x06
#define OTA_FRAME_EXIT          0x07

/* Device -> host */
#define OTA_FRAME_ACK           0x81
#define OTA_FRAME_NACK          0x82
#define OTA_FRAME_STATUS        0x83

/* Protocol v2: STATUS carries boot/device information in addition to the
 * original state/offset/version fields. */
#define OTA_PROTOCOL_VERSION    2U
#define OTA_BOOT_VERSION        0x01000000UL  /* 1.0.0 (0xMMmmRRRR) */
#define OTA_STATUS_LEN          40U

/* ACK code / NACK reason */
#define OTA_ERR_NONE            0
#define OTA_ERR_PARAM           1
#define OTA_ERR_ERASE           2
#define OTA_ERR_WRITE           3
#define OTA_ERR_OFFSET          4
#define OTA_ERR_VERIFY          5
#define OTA_ERR_NO_SESSION      6
#define OTA_ERR_BUSY            7
#define OTA_ERR_TOO_BIG         8

#define OTA_STATE_IDLE          0
#define OTA_STATE_RECEIVING     1
#define OTA_STATE_READY         2

#define OTA_MAX_PAYLOAD         1024
#define OTA_DATA_MIN            8
/* TYPE + SEQ + LEN + PAYLOAD + CRC16 */
#define OTA_MAX_FRAME           (5 + OTA_MAX_PAYLOAD + 2)
/* Device frames only carry small payloads (ACK/NACK/STATUS v2 = 40 B). */
#define OTA_TX_MAX_PAYLOAD      64

/* MCUboot image header magic, little endian at secondary slot offset 0. */
#define OTA_IMAGE_MAGIC         0x96F3B83DU

/* Drop a partial frame that stops in the middle instead of swallowing the
 * start of the next one. */
#define OTA_FRAME_TIMEOUT_MS    300U
/* While a session is open, allow for the long START sector erase. */
#define OTA_SESSION_TIMEOUT_MS  120000U

/* ---------------------------------------------------------------------- */
/* State                                                                  */
/* ---------------------------------------------------------------------- */
static uint8_t  frame_buf[OTA_MAX_FRAME];
static uint16_t frame_len;
static uint8_t  in_frame;
static uint8_t  escaped;
static uint8_t  frame_overflow;
static uint32_t last_byte_tick;

static uint8_t  ota_state;
static uint32_t img_total;
static uint32_t img_next;
static uint32_t img_crc_expect;
static uint32_t img_crc_run;
static struct tc_sha256_state_struct img_sha;
static const struct flash_area *img_fa;

/* EXIT lets the host return from a normal (application-requested) OTA
 * session immediately instead of waiting for the idle timeout. It is not
 * honoured in recovery mode, where there is no bootable image to return to. */
static uint8_t  ota_allow_exit;
static uint8_t  ota_exit_requested;

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */
static uint16_t crc16_ccitt(const uint8_t *data, uint32_t len)
{
    uint16_t crc = 0xFFFFU;
    uint32_t i;
    int bit;

    for (i = 0; i < len; i++) {
        crc ^= (uint16_t)((uint16_t)data[i] << 8);
        for (bit = 0; bit < 8; bit++) {
            if (crc & 0x8000U) {
                crc = (uint16_t)(((uint32_t)crc << 1) ^ 0x1021U);
            } else {
                crc = (uint16_t)((uint32_t)crc << 1);
            }
        }
    }
    return crc;
}

/* IEEE 802.3 CRC32, reflected poly 0xEDB88320. Start with 0xFFFFFFFF and
 * xor the result with 0xFFFFFFFF at the end. */
static uint32_t crc32_update(uint32_t crc, const uint8_t *data, uint32_t len)
{
    uint32_t i;
    int bit;

    for (i = 0; i < len; i++) {
        crc ^= data[i];
        for (bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320U & (uint32_t)(-(int32_t)(crc & 1U)));
        }
    }
    return crc;
}

static uint32_t rd_le32(const uint8_t *p)
{
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static void wr_le32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFU);
    p[1] = (uint8_t)((v >> 8) & 0xFFU);
    p[2] = (uint8_t)((v >> 16) & 0xFFU);
    p[3] = (uint8_t)((v >> 24) & 0xFFU);
}

/* Build, escape and transmit one frame on USART2. */
static void ota_send(uint8_t type, uint8_t seq, const uint8_t *payload,
                     uint16_t len)
{
    uint8_t raw[6 + OTA_TX_MAX_PAYLOAD];
    uint8_t wire[2U * (6 + OTA_TX_MAX_PAYLOAD) + 2U];
    uint16_t n = 0;
    uint16_t m = 0;
    uint16_t crc;
    uint16_t i;

    if (len > OTA_TX_MAX_PAYLOAD) {
        return;
    }

    raw[n++] = type;
    raw[n++] = seq;
    raw[n++] = (uint8_t)(len & 0xFFU);
    raw[n++] = (uint8_t)(len >> 8);
    for (i = 0; i < len; i++) {
        raw[n++] = payload[i];
    }
    crc = crc16_ccitt(raw, n);
    raw[n++] = (uint8_t)(crc & 0xFFU);
    raw[n++] = (uint8_t)(crc >> 8);

    wire[m++] = OTA_SOF;
    for (i = 0; i < n; i++) {
        if (raw[i] == OTA_SOF || raw[i] == OTA_ESC) {
            wire[m++] = OTA_ESC;
            wire[m++] = (uint8_t)(raw[i] ^ OTA_ESC_XOR);
        } else {
            wire[m++] = raw[i];
        }
    }
    wire[m++] = OTA_SOF;

    (void)HAL_UART_Transmit(&huart2, wire, m, 200);
}

static void ota_ack(uint8_t seq, uint8_t code, uint32_t next_offset)
{
    uint8_t p[5];

    p[0] = code;
    wr_le32(&p[1], next_offset);
    ota_send(OTA_FRAME_ACK, seq, p, sizeof(p));
}

static void ota_nack(uint8_t seq, uint8_t reason, uint32_t expected_offset)
{
    uint8_t p[5];

    p[0] = reason;
    wr_le32(&p[1], expected_offset);
    ota_send(OTA_FRAME_NACK, seq, p, sizeof(p));
}

/*
 * Read the version from an MCUboot image header:
 *   magic(4) load_addr(4) hdr_size(2) protect_tlv_size(2)
 *   img_size(4) flags(4) version @ offset 20 (major, minor, rev LE16, build).
 * Returns 0xMMmmRRRR, or 0 when the slot does not hold a valid image.
 */
static uint32_t slot_version(uint8_t area_id)
{
    const struct flash_area *fa;
    uint8_t v[4];
    uint32_t magic;
    uint32_t ver = 0;

    if (flash_area_open(area_id, &fa) != 0) {
        return 0;
    }
    if (flash_area_read(fa, 0, &magic, sizeof(magic)) == 0 &&
        magic == OTA_IMAGE_MAGIC &&
        flash_area_read(fa, 20, v, sizeof(v)) == 0) {
        ver = ((uint32_t)v[0] << 24) | ((uint32_t)v[1] << 16) |
              ((uint32_t)v[3] << 8) | (uint32_t)v[2];
    }
    flash_area_close(fa);
    return ver;
}

static void ota_session_reset(void)
{
    ota_state = OTA_STATE_IDLE;
    img_total = 0;
    img_next = 0;
    img_crc_expect = 0;
    img_crc_run = 0xFFFFFFFFU;
    if (img_fa != NULL) {
        flash_area_close(img_fa);
        img_fa = NULL;
    }
}

/*
 * Erase only what the transfer needs: every sector the image touches,
 * plus the last sector of the slot. MCUboot keeps its trailer (swap
 * flags + magic) at the end of the slot; boot_set_pending() programs it
 * without erasing, and after a swap the secondary slot still carries the
 * previous image's trailer, so that sector must always be erased.
 */
static int ota_erase_image(const struct flash_area *fa, uint32_t total)
{
    struct flash_sector sectors[MCUBOOT_MAX_IMG_SECTORS];
    uint32_t cnt = MCUBOOT_MAX_IMG_SECTORS;
    uint32_t erase_end = 0U;
    uint32_t i;

    if (flash_area_get_sectors(fa->fa_id, &cnt, sectors) != 0 || cnt == 0U) {
        return -1;
    }

    for (i = 0U; i < cnt; i++) {
        if (sectors[i].fs_off < total) {
            erase_end = sectors[i].fs_off + sectors[i].fs_size;
        }
    }
    if (erase_end == 0U) {
        return -1;
    }

    if (flash_area_erase(fa, 0U, erase_end) != 0) {
        return -1;
    }

    /* The trailer sector is separate unless the image reaches into it. */
    if (sectors[cnt - 1U].fs_off >= total) {
        if (flash_area_erase(fa, sectors[cnt - 1U].fs_off,
                             sectors[cnt - 1U].fs_size) != 0) {
            return -1;
        }
    }

    return 0;
}

/* ---------------------------------------------------------------------- */
/* Frame handlers                                                         */
/* ---------------------------------------------------------------------- */
static void ota_handle_start(uint8_t seq, const uint8_t *p, uint16_t len)
{
    uint32_t total;
    uint32_t crc;

    if (len != 8) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }
    if (ota_state != OTA_STATE_IDLE) {
        ota_nack(seq, OTA_ERR_BUSY, img_next);
        return;
    }

    total = rd_le32(&p[0]);
    crc = rd_le32(&p[4]);

    if (flash_area_open(FLASH_AREA_IMAGE_SECONDARY(0), &img_fa) != 0 ||
        img_fa == NULL) {
        img_fa = NULL;
        ota_nack(seq, OTA_ERR_PARAM, 0);
        return;
    }
    if (total <= MCUBOOT_APP_HEADER_SIZE || total > img_fa->fa_size) {
        ota_nack(seq, (total > img_fa->fa_size) ? OTA_ERR_TOO_BIG
                                                : OTA_ERR_PARAM, 0);
        flash_area_close(img_fa);
        img_fa = NULL;
        return;
    }

    /* Erase only the sectors this image occupies plus the slot's last
     * sector, where MCUboot keeps its trailer (programmed, not erased, by
     * boot_set_pending()). A full-slot image still erases all three 128 KB
     * sectors; the host's 30 s START timeout covers the worst case. */
    MCUBOOT_LOG_INF("OTA START size=%u", (unsigned)total);
    if (ota_erase_image(img_fa, total) != 0) {
        ota_nack(seq, OTA_ERR_ERASE, 0);
        flash_area_close(img_fa);
        img_fa = NULL;
        return;
    }

    img_total = total;
    img_next = 0;
    img_crc_expect = crc;
    img_crc_run = 0xFFFFFFFFU;
    (void)tc_sha256_init(&img_sha);
    ota_state = OTA_STATE_RECEIVING;

    ota_ack(seq, OTA_ERR_NONE, 0);
}

static void ota_handle_data(uint8_t seq, const uint8_t *p, uint16_t len)
{
    uint32_t offset;
    uint32_t data_len;

    if (ota_state != OTA_STATE_RECEIVING) {
        ota_nack(seq, OTA_ERR_NO_SESSION, img_next);
        return;
    }
    if (len < 4 + OTA_DATA_MIN || len > 4 + OTA_MAX_PAYLOAD) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }

    offset = rd_le32(&p[0]);
    data_len = (uint32_t)len - 4U;

    if (offset > img_total || data_len > img_total - offset) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }

    if (offset == img_next) {
        if (flash_area_write(img_fa, offset, &p[4], data_len) != 0) {
            ota_nack(seq, OTA_ERR_WRITE, img_next);
            return;
        }
        img_crc_run = crc32_update(img_crc_run, &p[4], data_len);
        (void)tc_sha256_update(&img_sha, &p[4], data_len);
        img_next += data_len;
        ota_ack(seq, OTA_ERR_NONE, img_next);
    } else if (offset < img_next && data_len <= img_next - offset) {
        /* Retransmission of data already written: re-ACK, do not rewrite. */
        ota_ack(seq, OTA_ERR_NONE, img_next);
    } else {
        ota_nack(seq, OTA_ERR_OFFSET, img_next);
    }
}

static void ota_handle_end(uint8_t seq, const uint8_t *p, uint16_t len)
{
    uint8_t digest[TC_SHA256_DIGEST_SIZE];
    uint32_t total;
    uint32_t crc;
    uint32_t magic;
    uint32_t expected;

    if (ota_state != OTA_STATE_RECEIVING) {
        ota_nack(seq, OTA_ERR_NO_SESSION, img_next);
        return;
    }
    if (len != 40) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }

    total = rd_le32(&p[0]);
    crc = rd_le32(&p[4]);
    (void)tc_sha256_final(digest, &img_sha);
    expected = img_next;

    if (total != img_total ||
        expected != img_total ||
        crc != img_crc_expect ||
        crc != (img_crc_run ^ 0xFFFFFFFFU) ||
        memcmp(digest, &p[8], TC_SHA256_DIGEST_SIZE) != 0 ||
        flash_area_read(img_fa, 0, &magic, sizeof(magic)) != 0 ||
        magic != OTA_IMAGE_MAGIC) {
        ota_session_reset();
        ota_nack(seq, OTA_ERR_VERIFY, expected);
        MCUBOOT_LOG_ERR("OTA verify failed at %u/%u",
                        (unsigned)expected, (unsigned)total);
        return;
    }

    ota_state = OTA_STATE_READY;
    ota_ack(seq, OTA_ERR_NONE, img_total);
    MCUBOOT_LOG_INF("OTA image verified, ready to apply");
}

static void ota_handle_apply(uint8_t seq, uint16_t len)
{
    if (len != 0) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }
    if (ota_state == OTA_STATE_RECEIVING) {
        ota_nack(seq, OTA_ERR_BUSY, img_next);
        return;
    }
    if (ota_state != OTA_STATE_READY) {
        ota_nack(seq, OTA_ERR_NO_SESSION, img_next);
        return;
    }

    if (boot_set_pending(0) != 0) {
        ota_nack(seq, OTA_ERR_WRITE, img_next);
        return;
    }

    ota_ack(seq, OTA_ERR_NONE, img_next);
    MCUBOOT_LOG_INF("OTA apply accepted, rebooting");
    HAL_Delay(50);
    NVIC_SystemReset();
}

static void ota_handle_abort(uint8_t seq)
{
    uint32_t received = img_next;

    ota_session_reset();
    ota_ack(seq, OTA_ERR_NONE, 0);
    MCUBOOT_LOG_INF("OTA aborted at %u", (unsigned)received);
}

/*
 * STATUS v2 layout (40 bytes, little endian):
 *   [0]  protocol version        [1]  OTA state
 *   [2]  active slot (0=primary) [3]  boot_swap_type()
 *   [4]  session offset          [8]  session total
 *   [12] primary version         [16] secondary version
 *   [20] slot size               [24] device UID (3 x u32)
 *   [36] bootloader version
 */
static void ota_handle_query(uint8_t seq)
{
    uint8_t p[OTA_STATUS_LEN];
    const struct flash_area *fa = NULL;
    uint32_t primary_ver;
    uint32_t secondary_ver;
    uint32_t slot_size = 0;
    uint32_t swap_type;

    primary_ver = slot_version(FLASH_AREA_IMAGE_PRIMARY(0));
    secondary_ver = slot_version(FLASH_AREA_IMAGE_SECONDARY(0));
    if (flash_area_open(FLASH_AREA_IMAGE_SECONDARY(0), &fa) == 0 &&
        fa != NULL) {
        slot_size = (uint32_t)fa->fa_size;
        flash_area_close(fa);
    }
    swap_type = (uint32_t)boot_swap_type();

    p[0] = (uint8_t)OTA_PROTOCOL_VERSION;
    p[1] = ota_state;
    /* This port always executes the application from the primary slot. */
    p[2] = (primary_ver != 0U) ? 0U : 0xFFU;
    p[3] = (uint8_t)swap_type;
    wr_le32(&p[4], img_next);
    wr_le32(&p[8], img_total);
    wr_le32(&p[12], primary_ver);
    wr_le32(&p[16], secondary_ver);
    wr_le32(&p[20], slot_size);
    wr_le32(&p[24], HAL_GetUIDw0());
    wr_le32(&p[28], HAL_GetUIDw1());
    wr_le32(&p[32], HAL_GetUIDw2());
    wr_le32(&p[36], OTA_BOOT_VERSION);

    ota_send(OTA_FRAME_STATUS, seq, p, sizeof(p));
}

/*
 * EXIT: ACK and leave the normal OTA window so the caller can boot the
 * application immediately. Only valid while idle in application-requested
 * mode; recovery mode keeps serving forever.
 */
static void ota_handle_exit(uint8_t seq, uint16_t len)
{
    if (len != 0) {
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        return;
    }
    if (!ota_allow_exit || ota_state != OTA_STATE_IDLE) {
        ota_nack(seq, OTA_ERR_BUSY, img_next);
        return;
    }

    ota_ack(seq, OTA_ERR_NONE, 0);
    ota_exit_requested = 1;
}

static void ota_handle_frame(void)
{
    uint8_t type;
    uint8_t seq;
    uint16_t len;
    uint16_t crc_rx;
    uint16_t crc_calc;

    if (frame_overflow || frame_len < 6) {
        return;
    }

    len = (uint16_t)((uint16_t)frame_buf[2] |
                     ((uint16_t)frame_buf[3] << 8));
    if (len > OTA_MAX_PAYLOAD || (uint16_t)(len + 6) != frame_len) {
        return;
    }

    crc_rx = (uint16_t)((uint16_t)frame_buf[frame_len - 2] |
                        ((uint16_t)frame_buf[frame_len - 1] << 8));
    crc_calc = crc16_ccitt(frame_buf, (uint32_t)(frame_len - 2));
    if (crc_rx != crc_calc) {
        /* The host retries after its ACK timeout. */
        return;
    }

    type = frame_buf[0];
    seq = frame_buf[1];

    switch (type) {
    case OTA_FRAME_START:
        ota_handle_start(seq, &frame_buf[4], len);
        break;
    case OTA_FRAME_DATA:
        ota_handle_data(seq, &frame_buf[4], len);
        break;
    case OTA_FRAME_END:
        ota_handle_end(seq, &frame_buf[4], len);
        break;
    case OTA_FRAME_APPLY:
        ota_handle_apply(seq, len);
        break;
    case OTA_FRAME_ABORT:
        ota_handle_abort(seq);
        break;
    case OTA_FRAME_QUERY:
        ota_handle_query(seq);
        break;
    case OTA_FRAME_EXIT:
        ota_handle_exit(seq, len);
        break;
    default:
        ota_nack(seq, OTA_ERR_PARAM, img_next);
        break;
    }
}

/* ---------------------------------------------------------------------- */
/* Byte-level receiver                                                    */
/* ---------------------------------------------------------------------- */
static void ota_feed_byte(uint8_t b)
{
    if (!in_frame) {
        if (b == OTA_SOF) {
            in_frame = 1;
            escaped = 0;
            frame_overflow = 0;
            frame_len = 0;
        }
        return; /* plain text bytes are ignored by the bootloader */
    }

    if (escaped) {
        b = (uint8_t)(b ^ OTA_ESC_XOR);
        escaped = 0;
    } else if (b == OTA_ESC) {
        escaped = 1;
        return;
    } else if (b == OTA_SOF) {
        /* SOF is either the end of this frame or the start of the next one.
         * Only deliver complete candidates; otherwise restart at this SOF. */
        if (frame_len >= 6) {
            ota_handle_frame();
        }
        escaped = 0;
        frame_overflow = 0;
        frame_len = 0;
        return;
    }

    if (frame_len < sizeof(frame_buf)) {
        frame_buf[frame_len++] = b;
    } else {
        frame_overflow = 1;
    }
}

/* Poll one byte from USART2 without interrupts (single-threaded bootloader). */
static int uart_get_byte(uint8_t *b)
{
    uint32_t sr = USART2->SR;

    if ((sr & USART_SR_RXNE) != 0U) {
        *b = (uint8_t)(USART2->DR & 0xFFU);
        return 1;
    }
    if ((sr & USART_SR_ORE) != 0U) {
        /* Reading SR followed by DR clears the overrun flag. */
        (void)USART2->DR;
    }
    return 0;
}

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */
int boot_ota_requested(void)
{
    __HAL_RCC_PWR_CLK_ENABLE();
    HAL_PWR_EnableBkUpAccess();
    return (RTC->BKP0R == BOOT_OTA_REQUEST_MAGIC) ? 1 : 0;
}

void boot_ota_clear_request(void)
{
    __HAL_RCC_PWR_CLK_ENABLE();
    HAL_PWR_EnableBkUpAccess();
    RTC->BKP0R = 0U;
}

void boot_ota_run(uint32_t idle_timeout_ms)
{
    uint32_t last_activity = HAL_GetTick();

    ota_session_reset();
    in_frame = 0;
    escaped = 0;
    frame_overflow = 0;
    frame_len = 0;
    last_byte_tick = last_activity;
    ota_allow_exit = (idle_timeout_ms != 0U) ? 1U : 0U;
    ota_exit_requested = 0U;

    MCUBOOT_LOG_INF("Serial OTA mode (protocol v%u), waiting for host on USART2",
                    (unsigned)OTA_PROTOCOL_VERSION);

    for (;;) {
        uint8_t b;

        while (uart_get_byte(&b)) {
            last_activity = HAL_GetTick();
            last_byte_tick = last_activity;
            ota_feed_byte(b);
        }

        if (ota_exit_requested) {
            MCUBOOT_LOG_INF("Host requested boot, leaving serial OTA mode");
            ota_session_reset();
            return;
        }

        if (in_frame &&
            (uint32_t)(HAL_GetTick() - last_byte_tick) > OTA_FRAME_TIMEOUT_MS) {
            in_frame = 0;
            escaped = 0;
            frame_overflow = 0;
            frame_len = 0;
        }

        if (idle_timeout_ms != 0U) {
            uint32_t limit = (ota_state == OTA_STATE_IDLE)
                                 ? idle_timeout_ms
                                 : OTA_SESSION_TIMEOUT_MS;

            if ((uint32_t)(HAL_GetTick() - last_activity) >= limit) {
                if (ota_state != OTA_STATE_IDLE) {
                    ota_session_reset();
                }
                MCUBOOT_LOG_INF("Serial OTA idle timeout, leaving OTA mode");
                return;
            }
        }
    }
}
