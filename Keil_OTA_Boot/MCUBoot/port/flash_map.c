/*
 * STM32F407VGT6 bare-metal port of MCUboot -- flash map backend.
 *
 * Implements the flash_area_* API required by boot/bootutil on top of
 * the STM32F4 HAL flash driver. The internal flash is memory-mapped at
 * 0x08000000 and has NON-UNIFORM sectors (see table below).
 *
 * WARNING: the CPU stalls while flash erase/program is in progress
 * (single-bank device). A 128 KB sector erase can take up to ~4 s in
 * worst case -- any watchdog must be configured with a longer timeout.
 */
#include <string.h>
#include <errno.h>
#include "stm32f4xx_hal.h"
#include "flash_map_backend/flash_map_backend.h"
#include "sysflash/sysflash.h"

/* The ARM C library only defines a minimal errno set (no POSIX values).
 * Provide the standard Linux numbering for the codes we return; the
 * actual values only need to be distinct and non-zero. */
#ifndef ENOENT
#define ENOENT  2
#endif
#ifndef EIO
#define EIO     5
#endif
#ifndef ENOMEM
#define ENOMEM  12
#endif
#ifndef EINVAL
#define EINVAL  22
#endif

#define STM32_FLASH_TOTAL_SECTORS  12

/* Real STM32F407VG flash sector table (offsets relative to 0x08000000). */
static const struct {
    uint32_t off;
    uint32_t size;
} stm32f4_sectors[STM32_FLASH_TOTAL_SECTORS] = {
    {0x00000000, 0x04000},              /* sec 0  : 16 KB */
    {0x00004000, 0x04000},              /* sec 1  : 16 KB */
    {0x00008000, 0x04000},              /* sec 2  : 16 KB */
    {0x0000C000, 0x04000},              /* sec 3  : 16 KB */
    {0x00010000, 0x10000},              /* sec 4  : 64 KB */
    {0x00020000, 0x20000},              /* sec 5  : 128 KB */
    {0x00040000, 0x20000},              /* sec 6  : 128 KB */
    {0x00060000, 0x20000},              /* sec 7  : 128 KB */
    {0x00080000, 0x20000},              /* sec 8  : 128 KB */
    {0x000A0000, 0x20000},              /* sec 9  : 128 KB */
    {0x000C0000, 0x20000},              /* sec 10 : 128 KB */
    {0x000E0000, 0x20000},              /* sec 11 : 128 KB */
};

/*
 * Static flash map. fa_off is relative to the flash device base
 * (0x08000000). The bootloader area (sectors 0-4) is intentionally NOT
 * part of this table, so no MCUboot code path can ever erase it.
 */
static const struct flash_area stm32f4_flash_map[] = {
    {
        .fa_id        = FLASH_AREA_IMAGE_0,
        .fa_device_id = FLASH_DEVICE_INTERNAL_FLASH,
        .pad16        = 0,
        .fa_off       = PRIMARY_SLOT_AREA_OFFSET,
        .fa_size      = PRIMARY_SLOT_AREA_SIZE,
    },
    {
        .fa_id        = FLASH_AREA_IMAGE_1,
        .fa_device_id = FLASH_DEVICE_INTERNAL_FLASH,
        .pad16        = 0,
        .fa_off       = SECONDARY_SLOT_AREA_OFFSET,
        .fa_size      = SECONDARY_SLOT_AREA_SIZE,
    },
    {
        .fa_id        = FLASH_AREA_IMAGE_SCRATCH,
        .fa_device_id = FLASH_DEVICE_INTERNAL_FLASH,
        .pad16        = 0,
        .fa_off       = SCRATCH_AREA_OFFSET,
        .fa_size      = SCRATCH_AREA_SIZE,
    },
};

#define FLASH_MAP_ENTRIES \
    (sizeof(stm32f4_flash_map) / sizeof(stm32f4_flash_map[0]))

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

static const struct flash_area *flash_map_find(uint8_t id)
{
    for (uint32_t i = 0; i < FLASH_MAP_ENTRIES; i++) {
        if (stm32f4_flash_map[i].fa_id == id) {
            return &stm32f4_flash_map[i];
        }
    }
    return NULL;
}

/* Translate a flash-device-relative offset to a sector index. */
static int offset_to_sector(uint32_t off)
{
    for (int i = 0; i < STM32_FLASH_TOTAL_SECTORS; i++) {
        if (off < stm32f4_sectors[i].off + stm32f4_sectors[i].size) {
            return (off >= stm32f4_sectors[i].off) ? i : -1;
        }
    }
    return -1;
}

/* ---------------------------------------------------------------------- */
/* flash_area_* API                                                       */
/* ---------------------------------------------------------------------- */

int flash_device_base(uint8_t fd_id, uintptr_t *ret)
{
    if (fd_id != FLASH_DEVICE_INTERNAL_FLASH || ret == NULL) {
        return -EINVAL;
    }
    *ret = STM32_FLASH_BASE;
    return 0;
}

int flash_area_open(uint8_t id, const struct flash_area **fa)
{
    if (fa == NULL) {
        return -EINVAL;
    }
    *fa = flash_map_find(id);
    return (*fa != NULL) ? 0 : -ENOENT;
}

/*
 * The map is a static const table, so closing is a no-op. Nested
 * open/close pairs are therefore harmless (see docs/PORTING.md).
 */
void flash_area_close(const struct flash_area *fa)
{
    (void)fa;
}

int flash_area_read(const struct flash_area *fa, uint32_t off, void *dst,
                    uint32_t len)
{
    if (fa == NULL || dst == NULL || off > fa->fa_size ||
        len > fa->fa_size - off) {
        return -EINVAL;
    }

    memcpy(dst, (void *)(STM32_FLASH_BASE + fa->fa_off + off), len);
    return 0;
}

int flash_area_write(const struct flash_area *fa, uint32_t off,
                     const void *src, uint32_t len)
{
    uint32_t addr;
    uint32_t done = 0;
    const uint8_t *sp = (const uint8_t *)src;

    if (fa == NULL || src == NULL || off > fa->fa_size ||
        len > fa->fa_size - off) {
        return -EINVAL;
    }
    if (len == 0) {
        return 0;
    }

    addr = STM32_FLASH_BASE + fa->fa_off + off;

    HAL_FLASH_Unlock();

    /* Program leading unaligned bytes one byte at a time. */
    while ((done < len) && ((addr & 0x3U) != 0U)) {
        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_BYTE, addr, sp[done]) != HAL_OK) {
            HAL_FLASH_Lock();
            return -EIO;
        }
        addr++;
        done++;
    }

    /* Program the bulk of the data as 32-bit words. */
    while ((len - done) >= 4U) {
        uint32_t word = (uint32_t)sp[done] |
                        ((uint32_t)sp[done + 1] << 8) |
                        ((uint32_t)sp[done + 2] << 16) |
                        ((uint32_t)sp[done + 3] << 24);
        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, addr, word) != HAL_OK) {
            HAL_FLASH_Lock();
            return -EIO;
        }
        addr += 4U;
        done += 4U;
    }

    /* Program trailing bytes one byte at a time. */
    while (done < len) {
        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_BYTE, addr, sp[done]) != HAL_OK) {
            HAL_FLASH_Lock();
            return -EIO;
        }
        addr++;
        done++;
    }

    HAL_FLASH_Lock();
    return 0;
}

int flash_area_erase(const struct flash_area *fa, uint32_t off, uint32_t len)
{
    FLASH_EraseInitTypeDef erase;
    uint32_t sector_error = 0;
    int first, last;

    if (fa == NULL || off > fa->fa_size || len > fa->fa_size - off) {
        return -EINVAL;
    }
    if (len == 0) {
        return 0;
    }

    /* The requested range must be sector-aligned. */
    first = offset_to_sector(fa->fa_off + off);
    if (first < 0) {
        return -EINVAL;
    }
    last = offset_to_sector(fa->fa_off + off + len - 1);
    if (last < 0) {
        return -EINVAL;
    }
    if ((stm32f4_sectors[first].off != fa->fa_off + off) ||
        (stm32f4_sectors[last].off + stm32f4_sectors[last].size !=
         fa->fa_off + off + len)) {
        return -EINVAL;
    }

    erase.TypeErase    = FLASH_TYPEERASE_SECTORS;
    erase.Banks        = FLASH_BANK_1;
    erase.Sector       = (uint32_t)first;
    erase.NbSectors    = (uint32_t)(last - first + 1);
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3;   /* Vdd 2.7-3.6 V */

    HAL_FLASH_Unlock();
    if (HAL_FLASHEx_Erase(&erase, &sector_error) != HAL_OK) {
        HAL_FLASH_Lock();
        return -EIO;
    }
    HAL_FLASH_Lock();
    return 0;
}

uint32_t flash_area_align(const struct flash_area *fa)
{
    (void)fa;
    /* STM32F4 supports byte-granularity programming. */
    return 1;
}

uint8_t flash_area_erased_val(const struct flash_area *fa)
{
    (void)fa;
    return 0xFF;
}

int flash_area_get_sectors(int fa_id, uint32_t *cnt,
                           struct flash_sector *ret)
{
    const struct flash_area *fa;
    uint32_t i, first, last, count = 0;

    fa = flash_map_find((uint8_t)fa_id);
    if (fa == NULL || cnt == NULL || ret == NULL) {
        return -EINVAL;
    }

    first = (uint32_t)offset_to_sector(fa->fa_off);
    last  = (uint32_t)offset_to_sector(fa->fa_off + fa->fa_size - 1);
    if ((first == (uint32_t)-1) || (last == (uint32_t)-1)) {
        return -EINVAL;
    }

    for (i = first; i <= last; i++) {
        if (count < *cnt) {
            /* fs_off is relative to the AREA start, not the device. */
            ret[count].fs_off  = stm32f4_sectors[i].off - fa->fa_off;
            ret[count].fs_size = stm32f4_sectors[i].size;
        }
        count++;
    }

    if (count > *cnt) {
        return -ENOMEM;
    }
    *cnt = count;
    return 0;
}

int flash_area_get_sector(const struct flash_area *fa, uint32_t off,
                          struct flash_sector *sector)
{
    int idx;

    if (fa == NULL || sector == NULL || off >= fa->fa_size) {
        return -EINVAL;
    }

    idx = offset_to_sector(fa->fa_off + off);
    if (idx < 0) {
        return -EINVAL;
    }

    /* fs_off is relative to the AREA start, not the device. */
    sector->fs_off  = stm32f4_sectors[idx].off - fa->fa_off;
    sector->fs_size = stm32f4_sectors[idx].size;
    return 0;
}

int flash_area_id_from_image_slot(int slot)
{
    switch (slot) {
    case 0: return FLASH_AREA_IMAGE_0;
    case 1: return FLASH_AREA_IMAGE_1;
    default: return -EINVAL;
    }
}

int flash_area_id_from_multi_image_slot(int image_index, int slot)
{
    if (image_index != 0) {
        return -EINVAL;
    }
    return flash_area_id_from_image_slot(slot);
}

int flash_area_id_to_multi_image_slot(int image_index, int area_id)
{
    if (image_index != 0) {
        return -EINVAL;
    }
    switch (area_id) {
    case FLASH_AREA_IMAGE_0: return 0;
    case FLASH_AREA_IMAGE_1: return 1;
    default: return -EINVAL;
    }
}

int flash_area_read_is_empty(const struct flash_area *fa, uint32_t off,
                             void *dst, uint32_t len)
{
    uint8_t i;
    uint8_t *buf = (uint8_t *)dst;
    int rc;

    rc = flash_area_read(fa, off, dst, len);
    if (rc != 0) {
        return -1;
    }
    for (i = 0; i < len; i++) {
        if (buf[i] != 0xFFU) {
            return 0;
        }
    }
    return 1;
}
