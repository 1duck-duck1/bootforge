/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (c) 2017-2020 Linaro LTD
 * Copyright (c) 2017-2019 JUUL Labs
 * Copyright (c) 2019-2021 Arm Limited
 *
 * Original license:
 *
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#ifndef H_BOOTUTIL_PRIV_
#define H_BOOTUTIL_PRIV_

#include <string.h>

#include "sysflash/sysflash.h"

#include <flash_map_backend/flash_map_backend.h>

#include "bootutil/bootutil.h"
#include "bootutil/image.h"
#include "bootutil/fault_injection_hardening.h"
#include "bootutil_area.h"
#include "mcuboot_config/mcuboot_config.h"

#ifdef MCUBOOT_ENC_IMAGES
#include "bootutil/enc_key.h"
#endif

#ifdef __cplusplus
extern "C" {
#endif

struct flash_area;

#if defined(MCUBOOT_LOGICAL_SECTOR_SIZE) && MCUBOOT_LOGICAL_SECTOR_SIZE != 0
/* 逻辑扇区偏移通过 ALIGN_DOWN() 向下对齐；而在关闭校验时使用的 Zephyr
 * flash_area_get_sector() 采用 ~(size - 1) 掩码运算。这两种算法都只有在
 * size 为 2 的幂时才正确。boot_verify_logical_sectors() 中的运行时校验是
 * 线性步进的，可能会错误接受诸如"用 48K 逻辑扇区平铺 16K 物理页存储块"
 * 的配置，此时掩码运算会把偏移舍入到一个根本不是扇区边界的地址。
 * 因此在编译期就拒绝这类非 2 的幂的配置。
 */
_Static_assert((MCUBOOT_LOGICAL_SECTOR_SIZE &
                (MCUBOOT_LOGICAL_SECTOR_SIZE - 1)) == 0,
               "MCUBOOT_LOGICAL_SECTOR_SIZE must be a power of two");
#endif

#if defined(MCUBOOT_VERIFY_LOGICAL_SECTORS) && \
    (!defined(MCUBOOT_LOGICAL_SECTOR_SIZE) || MCUBOOT_LOGICAL_SECTOR_SIZE == 0)
#error "MCUBOOT_VERIFY_LOGICAL_SECTORS requires a non-zero MCUBOOT_LOGICAL_SECTOR_SIZE"
#endif

/* 计算镜像哈希时分块读取镜像所用缓冲区的大小（字节）。
 * 对一个镜像的 Flash 读取次数为 ceil(image_size / BOOT_TMPBUF_SZ)，因此在
 * 非内存映射型 Flash（QSPI、SPI NOR、eMMC 等）上，每次读取都是一笔有固定
 * 开销的总线事务，该缓冲区大小会直接决定校验耗时。RAM 紧张的移植也可以把它
 * 调小。该缓冲区由 bootutil_img_validate() 的调用方分配，所以使用仓库自带
 * loader 的移植无法自行决定其大小。
 */
#ifdef MCUBOOT_BOOT_TMPBUF_SZ
_Static_assert(MCUBOOT_BOOT_TMPBUF_SZ > 0,
               "MCUBOOT_BOOT_TMPBUF_SZ must be greater than zero");
#define BOOT_TMPBUF_SZ  MCUBOOT_BOOT_TMPBUF_SZ
#else
#define BOOT_TMPBUF_SZ  256
#endif

/** Flash 中每个镜像的槽位数；目前最多支持两个（主槽、副槽）。 */
#if defined(MCUBOOT_SINGLE_APPLICATION_SLOT) || defined(MCUBOOT_SINGLE_APPLICATION_SLOT_RAM_LOAD)
#define BOOT_NUM_SLOTS                  1
#else
#define BOOT_NUM_SLOTS                  2
#endif

#if (defined(MCUBOOT_OVERWRITE_ONLY) + \
     defined(MCUBOOT_SWAP_USING_MOVE) + \
     defined(MCUBOOT_SWAP_USING_OFFSET) + \
     defined(MCUBOOT_DIRECT_XIP) + \
     defined(MCUBOOT_RAM_LOAD) + \
     defined(MCUBOOT_FIRMWARE_LOADER) + \
     defined(MCUBOOT_SWAP_USING_SCRATCH)) > 1
#error "Please enable only one of MCUBOOT_OVERWRITE_ONLY, MCUBOOT_SWAP_USING_MOVE, MCUBOOT_SWAP_USING_OFFSET, MCUBOOT_DIRECT_XIP, MCUBOOT_RAM_LOAD or MCUBOOT_FIRMWARE_LOADER"
#endif

#if !defined(MCUBOOT_DIRECT_XIP) && \
     defined(MCUBOOT_DIRECT_XIP_REVERT)
#error "MCUBOOT_DIRECT_XIP_REVERT cannot be enabled unless MCUBOOT_DIRECT_XIP is used"
#endif

#if !defined(MCUBOOT_OVERWRITE_ONLY) && \
    !defined(MCUBOOT_SWAP_USING_MOVE) && \
    !defined(MCUBOOT_SWAP_USING_OFFSET) && \
    !defined(MCUBOOT_DIRECT_XIP) && \
    !defined(MCUBOOT_RAM_LOAD) && \
    !defined(MCUBOOT_SINGLE_APPLICATION_SLOT) && \
    !defined(MCUBOOT_FIRMWARE_LOADER)
#define MCUBOOT_SWAP_USING_SCRATCH 1
#endif

#if defined(MCUBOOT_SWAP_USING_OFFSET)
#define BOOT_STATUS_OP_SWAP     1
#else
#define BOOT_STATUS_OP_MOVE     1
#define BOOT_STATUS_OP_SWAP     2
#endif

#if (BOOT_IMAGE_NUMBER > 1)
#define IMAGES_ITER(x) for ((x) = 0; (x) < BOOT_IMAGE_NUMBER; ++(x))
#else
#define IMAGES_ITER(x)
#endif

/*
 * 记录镜像搬运（copy）进度的运行时状态。
 */
struct boot_status {
    uint32_t idx;         /* 当前正在操作的扇区索引 */
    uint8_t state;        /* 当前处于交换流程的哪一步 */
    uint8_t op;           /* 当前正在执行的操作类型 */
    uint8_t use_scratch;  /* 状态字节是否会写入 scratch 区 */
    uint8_t swap_type;    /* 本次生效的交换类型 */
    uint32_t swap_size;   /* 被交换镜像的总大小 */
#ifdef MCUBOOT_ENC_IMAGES
    uint8_t enckey[BOOT_NUM_SLOTS][BOOT_ENC_KEY_ALIGN_SIZE];
#if MCUBOOT_SWAP_SAVE_ENCTLV
    uint8_t enctlv[BOOT_NUM_SLOTS][BOOT_ENC_TLV_ALIGN_SIZE];
#endif
#endif
    int source;           /* 交换状态元数据存放在哪个槽中 */
};

#define BOOT_STATUS_IDX_0   1

#define BOOT_STATUS_STATE_0 1
#define BOOT_STATUS_STATE_1 2
#define BOOT_STATUS_STATE_2 3

/**
 * 镜像槽尾部（image trailer）的存储结构。
 *
 * 图中英文标注的中文含义：
 *   Swap status     —— 交换状态区（逐扇区记录搬运进度，支持断电恢复）
 *   Encryption key  —— 加密密钥（KEK）
 *   Swap size       —— 本次交换的总大小
 *   Swap info       —— 交换信息（交换类型 + 镜像编号）
 *   Copy done       —— 搬运完成标志
 *   Image OK        —— 镜像确认标志（App 自检通过后置位）
 *   MAGIC           —— trailer 魔数
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  ~                                                               ~
 *  ~    Swap status (BOOT_MAX_IMG_SECTORS * min-write-size * 3)    ~
 *  ~                                                               ~
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                 Encryption key 0 (16 octets) [*]              |
 *  |                                                               |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                    0xff padding as needed                     |
 *  |  (BOOT_MAX_ALIGN minus 16 octets from Encryption key 0) [*]   |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                 Encryption key 1 (16 octets) [*]              |
 *  |                                                               |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                    0xff padding as needed                     |
 *  |  (BOOT_MAX_ALIGN minus 16 octets from Encryption key 1) [*]   |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                      Swap size (4 octets)                     |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                    0xff padding as needed                     |
 *  |        (BOOT_MAX_ALIGN minus 4 octets from Swap size)         |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |   Swap info   |  0xff padding (BOOT_MAX_ALIGN minus 1 octet)  |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |   Copy done   |  0xff padding (BOOT_MAX_ALIGN minus 1 octet)  |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |   Image OK    |  0xff padding (BOOT_MAX_ALIGN minus 1 octet)  |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                    0xff padding as needed                     |
 *  |         (BOOT_MAX_ALIGN minus 16 octets from MAGIC)           |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                       MAGIC (16 octets)                       |
 *  |                                                               |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *
 * [*]: 仅在启用镜像加密选项（`MCUBOOT_ENC_IMAGES`）时存在。
 */

union boot_img_magic_t
{
    struct {
        uint16_t align;
        uint8_t magic[14];
    };
    uint8_t val[16];
};

extern const union boot_img_magic_t boot_img_magic;

#define BOOT_IMG_MAGIC  (boot_img_magic.val)

#if BOOT_MAX_ALIGN == 8
#define BOOT_IMG_ALIGN  (BOOT_MAX_ALIGN)
#else
#define BOOT_IMG_ALIGN  (boot_img_magic.align)
#endif

_Static_assert(sizeof(boot_img_magic) == BOOT_MAGIC_SZ, "Invalid size for image magic");

#if !defined(MCUBOOT_DIRECT_XIP) && !defined(MCUBOOT_RAM_LOAD)
#define ARE_SLOTS_EQUIVALENT()    0
#else
#define ARE_SLOTS_EQUIVALENT()    1

#if defined(MCUBOOT_DIRECT_XIP) && defined(MCUBOOT_ENC_IMAGES)
#error "Image encryption (MCUBOOT_ENC_IMAGES) is not supported when MCUBOOT_DIRECT_XIP is selected."
#endif /* MCUBOOT_DIRECT_XIP && MCUBOOT_ENC_IMAGES */
#endif /* MCUBOOT_DIRECT_XIP || MCUBOOT_RAM_LOAD */

#define BOOT_LOG_IMAGE_INFO(slot, hdr)                                    \
    BOOT_LOG_INF("%-9s slot: version=%u.%u.%u+%u",                        \
                 ((slot) == BOOT_SLOT_PRIMARY) ? "Primary" : "Secondary", \
                 (hdr)->ih_ver.iv_major,                                  \
                 (hdr)->ih_ver.iv_minor,                                  \
                 (hdr)->ih_ver.iv_revision,                               \
                 (hdr)->ih_ver.iv_build_num)

/**
 * Flash 扇区类型的兼容垫片（typedef）。
 *
 * 待 flash_area_to_sectors() 接口被移除后，此垫片即可删除。
 */
#ifdef MCUBOOT_USE_FLASH_AREA_GET_SECTORS
typedef struct flash_sector boot_sector_t;
#else
typedef struct flash_area boot_sector_t;
#endif

/** 启动过程中维护的内部（私有）状态。 */
struct boot_loader_state {
    struct {
        struct image_header hdr;
        const struct flash_area *area;
#if !defined(MCUBOOT_LOGICAL_SECTOR_SIZE) || MCUBOOT_LOGICAL_SECTOR_SIZE == 0
        boot_sector_t *sectors;
#endif
        uint32_t num_sectors;
#if defined(MCUBOOT_SWAP_USING_OFFSET)
        uint16_t unprotected_tlv_size;
#endif
    } imgs[BOOT_IMAGE_NUMBER][BOOT_NUM_SLOTS];

#if MCUBOOT_SWAP_USING_SCRATCH
    struct {
        const struct flash_area *area;
#if !defined(MCUBOOT_LOGICAL_SECTOR_SIZE) || MCUBOOT_LOGICAL_SECTOR_SIZE == 0
        boot_sector_t *sectors;
#endif
        uint32_t num_sectors;
    } scratch;
#endif

    uint8_t swap_type[BOOT_IMAGE_NUMBER];
    uint32_t write_sz[BOOT_IMAGE_NUMBER];

#if defined(MCUBOOT_SWAP_USING_OFFSET)
    uint32_t secondary_offset[BOOT_IMAGE_NUMBER];
#if defined(MCUBOOT_BOOTSTRAP)
    bool bootstrap_secondary_offset_set[BOOT_IMAGE_NUMBER];
#endif
#endif

#if defined(MCUBOOT_ENC_IMAGES)
    struct enc_key_data enc[BOOT_IMAGE_NUMBER][BOOT_NUM_SLOTS];
#endif

#if (BOOT_IMAGE_NUMBER > 1)
    uint8_t curr_img_idx;
    bool img_mask[BOOT_IMAGE_NUMBER];
#endif

#if defined(MCUBOOT_DIRECT_XIP) || defined(MCUBOOT_RAM_LOAD)
    struct slot_usage_t {
        /* 被选中执行/加载的槽的索引 */
        uint32_t active_slot;
        bool slot_available[BOOT_NUM_SLOTS];
#if defined(MCUBOOT_RAM_LOAD)
        /* 活动槽镜像的 RAM 目标地址与大小 */
        uint32_t img_dst;
        uint32_t img_sz;
#endif
#if defined(MCUBOOT_DIRECT_XIP_REVERT) || defined(MCUBOOT_RAM_LOAD_REVERT)
        /* 活动槽对应的交换状态（用于回滚判定） */
        struct boot_swap_state swap_state;
#endif
    } slot_usage[BOOT_IMAGE_NUMBER];
#endif /* MCUBOOT_DIRECT_XIP || MCUBOOT_RAM_LOAD */
};

struct boot_sector_buffer {
    boot_sector_t primary[BOOT_IMAGE_NUMBER][BOOT_MAX_IMG_SECTORS];
    boot_sector_t secondary[BOOT_IMAGE_NUMBER][BOOT_MAX_IMG_SECTORS];
#if MCUBOOT_SWAP_USING_SCRATCH
    boot_sector_t scratch[BOOT_MAX_IMG_SECTORS];
#endif
};

/* 该函数用于用给定的签名验证消息（通常是镜像哈希）。
 * 若启用了 MCUBOOT_SIGN_PURE，则 msg 应指向待验签的镜像本体，
 * mlen 为镜像大小；否则 msg 应指向镜像的哈希值，mlen 为哈希长度。
 */
fih_ret bootutil_verify_sig(uint8_t *msg, uint32_t mlen, uint8_t *sig,
                            size_t slen, uint8_t key_id);

fih_ret boot_fih_memequal(const void *s1, const void *s2, size_t n);

const struct flash_area *boot_find_status(const struct boot_loader_state *state,
                                          int image_index);
int boot_magic_compatible_check(uint8_t tbl_val, uint8_t val);
int boot_status_entries(int image_index, const struct flash_area *fap);
uint32_t boot_status_off(const struct flash_area *fap);
int boot_read_swap_state(const struct flash_area *fap,
                         struct boot_swap_state *state);
int boot_write_magic(const struct flash_area *fap);
int boot_write_status(const struct boot_loader_state *state, struct boot_status *bs);
int boot_write_copy_done(const struct flash_area *fap);
int boot_write_image_ok(const struct flash_area *fap);
int boot_write_swap_info(const struct flash_area *fap, uint8_t swap_type,
                         uint8_t image_num);
int boot_write_swap_size(const struct flash_area *fap, uint32_t swap_size);
int boot_write_trailer(const struct flash_area *fap, uint32_t off,
                       const uint8_t *inbuf, uint8_t inlen);
int boot_write_trailer_flag(const struct flash_area *fap, uint32_t off,
                            uint8_t flag_val);
int boot_read_swap_size(const struct flash_area *fap, uint32_t *swap_size);
#if defined(MCUBOOT_SWAP_USING_OFFSET)
int boot_write_unprotected_tlv_sizes(const struct flash_area *fap, uint16_t tlv_size_primary,
                                     uint16_t tlv_size_secondary);
int boot_read_unprotected_tlv_sizes(const struct flash_area *fap, uint16_t *tlv_size_primary,
                                    uint16_t *tlv_size_secondary);
#endif
int boot_slots_compatible(struct boot_loader_state *state);
uint32_t boot_status_internal_off(const struct boot_status *bs, int elem_sz);
int boot_read_image_header(struct boot_loader_state *state, int slot,
                           struct image_header *out_hdr, struct boot_status *bs);
#if defined(MCUBOOT_SWAP_USING_OFFSET) && defined(MCUBOOT_ENC_IMAGES)
int boot_copy_region(struct boot_loader_state *state,
                     const struct flash_area *fap_src,
                     const struct flash_area *fap_dst,
                     uint32_t off_src, uint32_t off_dst, uint32_t sz, uint32_t sector_off);
#else
int boot_copy_region(struct boot_loader_state *state,
                     const struct flash_area *fap_src,
                     const struct flash_area *fap_dst,
                     uint32_t off_src, uint32_t off_dst, uint32_t sz);
#endif
bool boot_status_is_reset(const struct boot_status *bs);

#ifdef MCUBOOT_ENC_IMAGES
int boot_write_enc_keys(const struct flash_area *fap, const struct boot_status *bs);
bool boot_read_enc_key(const struct flash_area *fap, uint8_t slot,
                       struct boot_status *bs);
#endif

/**
 * 检查缓冲区是否处于已擦除状态，判据为 `flash_area` 对应 Flash 器件的擦除值
 * （通常擦除后全为 0xFF）。
 *
 * @return 缓冲区全部为擦除值时返回 true；存在任一字节不是擦除值、
 *         buffer 为 NULL 或 len == 0 时返回 false。
 */
bool bootutil_buffer_is_erased(const struct flash_area *area,
                               const void *buffer, size_t len);

/**
 * 打开所有镜像对应的 Flash 区域。
 *
 * @param[in] state Bootloader 状态。
 *
 * @return 成功返回 0，失败返回其他值。
 */
int boot_open_all_flash_areas(struct boot_loader_state *state);

/**
 * 关闭所有镜像对应的 Flash 区域。
 *
 * @param[in] state Bootloader 状态。
 */
void boot_close_all_flash_areas(struct boot_loader_state *state);

#if !defined(MCUBOOT_DIRECT_XIP) && !defined(MCUBOOT_RAM_LOAD)
/**
 * 探测两个镜像槽以及 scratch 区的扇区布局。
 *
 * 这些信息是计算镜像交换过程中需要擦除和搬运的字节数的前提；
 * 本函数采集到的信息会用于填充 boot_loader_state。
 *
 * @param[in] state   Bootloader 状态。
 * @param[in] sectors 用于存放扇区布局的缓冲区；若为 NULL，则使用
 *                    loader.c 中静态分配的缓冲区。
 *
 * @return 成功返回 0，失败返回其他值。
 */
int boot_read_sectors(struct boot_loader_state *state, struct boot_sector_buffer *sectors);
#endif

/**
 * uint32_t 安全加法（防溢出）。若相加不发生溢出，返回 true 并将结果存入
 * *dest；否则返回 false。
 */
static inline bool boot_u32_safe_add(uint32_t *dest, uint32_t a, uint32_t b)
{
    /*
     * 判断 "a + b <= UINT32_MAX" 时，为避免相加本身溢出，
     * 不等式两边同时减去 b，等价改写为 "a <= UINT32_MAX - b"。
     */
    if (a > UINT32_MAX - b) {
        return false;
    } else {
        *dest = a + b;
        return true;
    }
}

/**
 * 校验镜像头中的大小字段是否合法，即"镜像头 + 载荷（+ 受保护 TLV）"的总尺寸
 * 能够放进 Flash 槽内。尺寸判定规则与 boot_check_header_valid() 保持一致。
 */
static inline bool
bootutil_image_hdr_sizes_valid(const struct image_header *hdr,
                              const struct flash_area *fap,
                              int image_index)
{
    uint32_t size;

    if (hdr == NULL || fap == NULL) {
        return false;
    }

#if !defined(MCUBOOT_DECOMPRESS_IMAGES)
    (void)image_index;
#endif

    if (hdr->ih_hdr_size < IMAGE_HEADER_SIZE) {
        return false;
    }

    if (!boot_u32_safe_add(&size, hdr->ih_img_size, hdr->ih_hdr_size)) {
        return false;
    }

#if defined(MCUBOOT_DECOMPRESS_IMAGES)
    if (!MUST_DECOMPRESS(fap, image_index, hdr)) {
#else
    if (1) {
#endif
        if (!boot_u32_safe_add(&size, size, hdr->ih_protect_tlv_size)) {
            return false;
        }
    }

    if (size >= flash_area_get_size(fap)) {
        return false;
    }

    return true;
}

/**
 * 校验 TLV 偏移（BOOT_TLV_OFF，可选再叠加交换偏移）是否合法，并确保 TLV
 * 信息头完整落在 Flash 槽范围内；校验通过时把计算出的偏移写入出参。
 */
static inline bool
bootutil_image_tlv_off_valid_set(uint32_t *tlv_off_out,
                                 const struct image_header *hdr,
                                 const struct flash_area *fap,
                                 uint32_t start_off)
{
    uint32_t off_;
    uint32_t end;

    if (tlv_off_out == NULL || hdr == NULL || fap == NULL) {
        return false;
    }

    if (hdr->ih_hdr_size < IMAGE_HEADER_SIZE) {
        return false;
    }

    if (!boot_u32_safe_add(&off_, hdr->ih_hdr_size, hdr->ih_img_size)) {
        return false;
    }

    if (!boot_u32_safe_add(&off_, off_, start_off)) {
        return false;
    }

    if (!boot_u32_safe_add(&end, off_, sizeof(struct image_tlv_info))) {
        return false;
    }

    if (end > flash_area_get_size(fap)) {
        return false;
    }

    *tlv_off_out = off_;
    return true;
}

/**
 * uint16_t 安全加法（防溢出）。若相加不发生溢出，返回 true 并将结果存入
 * *dest；否则返回 false。
 */
static inline bool boot_u16_safe_add(uint16_t *dest, uint16_t a, uint16_t b)
{
    uint32_t tmp = a + b;
    if (tmp > UINT16_MAX) {
        return false;
    } else {
        *dest = tmp;
        return true;
    }
}

/*
 * struct boot_loader_state 内部成员的访问器。
 */

/* 以下定义为宏，以便它们可以作为左值（lvalue）被赋值。 */
#if (BOOT_IMAGE_NUMBER > 1)
#define BOOT_CURR_IMG(state) ((state)->curr_img_idx)
#else
#define BOOT_CURR_IMG(state) 0
#endif
#ifdef MCUBOOT_ENC_IMAGES
#define BOOT_CURR_ENC(state) ((state)->enc[BOOT_CURR_IMG(state)])
#define BOOT_CURR_ENC_SLOT(state, slot) (&((state)->enc[BOOT_CURR_IMG(state)][slot]))
#else
#define BOOT_CURR_ENC(state) NULL
#define BOOT_CURR_ENC_SLOT(state, slot) NULL
#endif
#define BOOT_IMG(state, slot) ((state)->imgs[BOOT_CURR_IMG(state)][(slot)])
#define BOOT_IMG_AREA(state, slot) (BOOT_IMG(state, slot).area)
#define BOOT_IMG_UNPROTECTED_TLV_SIZE(state, slot) (BOOT_IMG(state, slot).unprotected_tlv_size)
#define BOOT_WRITE_SZ(state) ((state)->write_sz[BOOT_CURR_IMG(state)])
#define BOOT_SWAP_TYPE(state) ((state)->swap_type[BOOT_CURR_IMG(state)])
#define BOOT_TLV_OFF(hdr) ((hdr)->ih_hdr_size + (hdr)->ih_img_size)

#define BOOT_IS_UPGRADE(swap_type)             \
    (((swap_type) == BOOT_SWAP_TYPE_TEST) ||   \
     ((swap_type) == BOOT_SWAP_TYPE_REVERT) || \
     ((swap_type) == BOOT_SWAP_TYPE_PERM))

static inline struct image_header*
boot_img_hdr(struct boot_loader_state *state, size_t slot)
{
    return &BOOT_IMG(state, slot).hdr;
}

static inline size_t
boot_img_num_sectors(const struct boot_loader_state *state, size_t slot)
{
    return BOOT_IMG(state, slot).num_sectors;
}

/*
 * 返回槽相对于 Flash 器件起始地址的偏移。
 */
static inline uint32_t
boot_img_slot_off(struct boot_loader_state *state, size_t slot)
{
    return flash_area_get_off(BOOT_IMG_AREA(state, slot));
}

#if !defined(MCUBOOT_LOGICAL_SECTOR_SIZE) || MCUBOOT_LOGICAL_SECTOR_SIZE == 0
#ifndef MCUBOOT_USE_FLASH_AREA_GET_SECTORS

static inline size_t
boot_img_sector_size(const struct boot_loader_state *state,
                     size_t slot, size_t sector)
{
    return flash_area_get_size(&BOOT_IMG(state, slot).sectors[sector]);
}

/*
 * 返回扇区相对于镜像起始位置的偏移（注意：不是相对于 Flash 器件的偏移）。
 */
static inline uint32_t
boot_img_sector_off(const struct boot_loader_state *state, size_t slot,
                    size_t sector)
{
    return flash_area_get_off(&BOOT_IMG(state, slot).sectors[sector]) -
           flash_area_get_off(&BOOT_IMG(state, slot).sectors[0]);
}

#else  /* defined(MCUBOOT_USE_FLASH_AREA_GET_SECTORS) */

static inline size_t
boot_img_sector_size(const struct boot_loader_state *state,
                     size_t slot, size_t sector)
{
    return flash_sector_get_size(&BOOT_IMG(state, slot).sectors[sector]);
}

static inline uint32_t
boot_img_sector_off(const struct boot_loader_state *state, size_t slot,
                    size_t sector)
{
    return flash_sector_get_off(&BOOT_IMG(state, slot).sectors[sector]) -
           flash_sector_get_off(&BOOT_IMG(state, slot).sectors[0]);
}

#endif  /* !defined(MCUBOOT_USE_FLASH_AREA_GET_SECTORS) */
#else
static inline size_t
boot_img_sector_size(const struct boot_loader_state *state,
                     size_t slot, size_t sector)
{
    (void)state;
    (void)slot;
    (void)sector;

    return MCUBOOT_LOGICAL_SECTOR_SIZE;
}

/*
 * 返回扇区相对于镜像起始位置的偏移（注意：不是相对于 Flash 器件的偏移）。
 */
static inline uint32_t
boot_img_sector_off(const struct boot_loader_state *state, size_t slot,
                    size_t sector)
{
    (void)state;
    (void)slot;

    return MCUBOOT_LOGICAL_SECTOR_SIZE * sector;
}
#endif

#ifdef MCUBOOT_RAM_LOAD
#   ifdef __BOOTSIM__

/* 查询适合存放镜像的 RAM 缓冲区布局（仅用于 PC 模拟器 __BOOTSIM__）。
 * 该信息按每个测试线程独立维护，因此必须通过本接口查询。 */
struct bootsim_ram_info {
    uint32_t start;
    uint32_t size;
    uintptr_t base;
};
struct bootsim_ram_info *bootsim_get_ram_info(void);

#define IMAGE_GET_FIELD(field) (bootsim_get_ram_info()->field)
#define IMAGE_RAM_BASE IMAGE_GET_FIELD(base)
#define IMAGE_EXECUTABLE_RAM_START IMAGE_GET_FIELD(start)
#define IMAGE_EXECUTABLE_RAM_SIZE IMAGE_GET_FIELD(size)

#   else
#       define IMAGE_RAM_BASE ((uintptr_t)0)
#   endif

#define LOAD_IMAGE_DATA_RAM(hdr, fap, start, output, size)                    \
    (memcpy((output),(void*)(IMAGE_RAM_BASE + (hdr)->ih_load_addr + (start)), \
    (size)), 0)

#ifdef MCUBOOT_SERIAL
void boot_init_image_data_in_ram(void);
fih_ret boot_image_data_in_ram(void);
void boot_set_image_data_in_nvm(void);

#define LOAD_IMAGE_DATA_NVM(hdr, fap, start, output, size)       \
    (flash_area_read((fap), (start), (output), (size)))

#define LOAD_IMAGE_DATA(hdr, fap, start, output, size)                              \
    FIH_NOT_EQ(boot_image_data_in_ram(), FIH_NEGATIVE_VALUE) ? \
                   LOAD_IMAGE_DATA_RAM(hdr, fap, start, output, size) : \
                   LOAD_IMAGE_DATA_NVM(hdr, fap, start, output, size)
#else
#define LOAD_IMAGE_DATA(hdr, fap, start, output, size) \
        LOAD_IMAGE_DATA_RAM(hdr, fap, start, output, size)
#endif /* MCUBOOT_SERIAL */

int boot_load_image_to_sram(struct boot_loader_state *state);
#else
#define IMAGE_RAM_BASE ((uintptr_t)0)

#define LOAD_IMAGE_DATA(hdr, fap, start, output, size)       \
    (flash_area_read((fap), (start), (output), (size)))

#endif /* MCUBOOT_RAM_LOAD */

uint32_t bootutil_max_image_size(struct boot_loader_state *state, const struct flash_area *fap);

int boot_read_image_size(struct boot_loader_state *state, int slot,
                         uint32_t *size);

#ifdef __cplusplus
}
#endif

#endif
