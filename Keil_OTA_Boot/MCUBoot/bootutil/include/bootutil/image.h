/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copyright (c) 2016-2019 Linaro LTD
 * Copyright (c) 2016-2019 JUUL Labs
 * Copyright (c) 2019-2023 Arm Limited
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

#ifndef H_IMAGE_
#define H_IMAGE_

#include <inttypes.h>
#include <stdbool.h>
#include "bootutil/fault_injection_hardening.h"

#ifdef __cplusplus
extern "C" {
#endif

#if defined(STRUCT_PACKED)
#undef STRUCT_PACKED
#endif

#if defined(__IAR_SYSTEMS_ICC__)
#define STRUCT_PACKED __packed struct
#else
#define STRUCT_PACKED struct __attribute__((__packed__))
#endif

#define IMAGE_MAGIC                 0x96f3b83d  /* 镜像头魔数 */
#define IMAGE_MAGIC_V1              0x96f3b83c  /* 镜像头魔数（版本 1） */
#define IMAGE_MAGIC_NONE            0xffffffff  /* 镜像头魔数（无） */
#define IMAGE_TLV_INFO_MAGIC        0x6907  /* 镜像头 TLV 信息魔数 */
#define IMAGE_TLV_PROT_INFO_MAGIC   0x6908  /* 镜像头 TLV 保护信息魔数 */

#define IMAGE_HEADER_SIZE           32  /* 镜像头大小（字节） */
#define IMAGE_HASH_LEN              32 /* SHA256 TLV 哈希长度（字节） */

/*
 * 镜像头标志位（ih_flags 字段）。
 */
#define IMAGE_F_PIC                      0x00000001 /* 位置无关代码（PIC），暂不支持 */
#define IMAGE_F_ENCRYPTED_AES128         0x00000004 /* 使用 AES128 加密 */
#define IMAGE_F_ENCRYPTED_AES256         0x00000008 /* 使用 AES256 加密 */
#define IMAGE_F_NON_BOOTABLE             0x00000010 /* 分离镜像（split image）应用，不可独立启动 */
/*
 * 表示该镜像应加载到 RAM 中运行，而不是直接从 Flash 就地执行（XIP）。
 * 加载目标地址存放在镜像头的 ih_load_addr 字段中。
 */
#define IMAGE_F_RAM_LOAD                 0x00000020

/*
 * 表示 ih_load_addr 中存放的是该镜像编译链接时所对应的 Flash/ROM 固定地址。
 */
#define IMAGE_F_ROM_FIXED                0x00000100

/*
 * 标识镜像数据压缩算法的标志位。
 */
#define IMAGE_F_COMPRESSED_LZMA1         0x00000200
#define IMAGE_F_COMPRESSED_LZMA2         0x00000400
#define IMAGE_F_COMPRESSED_ARM_THUMB_FLT 0x00000800

/*
 * ECDSA224 使用 NIST P-224 曲线
 * ECDSA256 使用 NIST P-256 曲线
 */

/*
 * 镜像尾部 TLV 类型定义。
 *
 * 签名是针对"镜像哈希值"计算得到的（而不是直接对镜像本体签名）。
 *
 * 签名信息以两个 TLV 的形式给出：
 *   第 1 个标识验签时应使用哪一把公钥；
 *   第 2 个才是真正的签名数据。
 */
#define IMAGE_TLV_KEYHASH           0x01    /* 公钥的哈希值 */
#define IMAGE_TLV_PUBKEY            0x02    /* 公钥 */
#define IMAGE_TLV_SHA256            0x10    /* 镜像头与镜像体的 SHA256 哈希 */
#define IMAGE_TLV_SHA384            0x11    /* 镜像头与镜像体的 SHA384 哈希 */
#define IMAGE_TLV_SHA512            0x12    /* 镜像头与镜像体的 SHA512 哈希 */
#define IMAGE_TLV_RSA2048_PSS       0x20    /* 对哈希输出的 RSA2048-PSS 签名 */
#define IMAGE_TLV_ECDSA224          0x21    /* 对哈希输出的 ECDSA 签名，已不再支持 */
#define IMAGE_TLV_ECDSA_SIG         0x22    /* 对哈希输出的 ECDSA 签名 */
#define IMAGE_TLV_RSA3072_PSS       0x23    /* 对哈希输出的 RSA3072-PSS 签名 */
#define IMAGE_TLV_ED25519           0x24    /* 对哈希输出的 Ed25519 签名 */
#define IMAGE_TLV_SIG_PURE          0x25    /* 标识所附带的签名是直接对镜像本体计算的，
                                             * 而不是对其摘要计算的。
                                             */
#define IMAGE_TLV_ENC_RSA2048       0x30    /* 使用 RSA-OAEP-2048 加密后的密钥 */
#define IMAGE_TLV_ENC_KW            0x31    /* 使用 AES-KW 128 或 256 加密后的密钥 */
#define IMAGE_TLV_ENC_EC256         0x32    /* 使用 ECIES-EC256 加密后的密钥 */
#define IMAGE_TLV_ENC_X25519        0x33    /* 使用 ECIES-X25519 加密后的密钥 */
#define IMAGE_TLV_ENC_X25519_SHA512 0x34    /* 使用 ECIES-X25519 完成密钥协商，并在密钥派生
                                             * 过程中用 SHA512 计算 MAC 标签与 HKDF
                                             */
#define IMAGE_TLV_DEPENDENCY        0x40    /* 本镜像依赖其他镜像 */
#define IMAGE_TLV_SEC_CNT           0x50    /* 安全计数器（防回滚） */
#define IMAGE_TLV_BOOT_RECORD       0x60    /* 度量启动记录（measured boot record） */
/* 以下标志与压缩镜像相关，描述的是"解压后镜像数据"的信息 */
#define IMAGE_TLV_DECOMP_SIZE       0x70    /* 解压后的镜像大小（不含镜像头/TLV） */
#define IMAGE_TLV_DECOMP_SHA        0x71    /*
                                             * 解压后镜像的 shaX 哈希；该字段的格式与长度
                                             * 必须与原始槽内（压缩态）镜像的 shaX 哈希一致
                                             */
#define IMAGE_TLV_DECOMP_SIGNATURE  0x72    /*
                                             * 解压后镜像的签名；该字段的格式与长度
                                             * 必须与原始槽内（压缩态）镜像的签名一致
                                             */
#define IMAGE_TLV_COMP_DEC_SIZE     0x73    /* 压缩且加密的镜像解压后的大小 */
#define IMAGE_TLV_UUID_VID          0x74    /* 厂商唯一标识符 */
#define IMAGE_TLV_UUID_CID          0x75    /* 设备类别唯一标识符 */
                                            /*
                                             * 厂商保留 TLV 类型范围为 xxA0-xxFF，
                                             * 其中 xx 表示高字节取值。
                                             * 例如：
                                             * 0x00a0 - 0x00ff
                                             * 0x01a0 - 0x01ff
                                             * 0x02a0 - 0x02ff
                                             * ...
                                             * 0xffa0 - 0xfffe
                                             */
#define IMAGE_TLV_ANY               0xffff  /* 通配类型，用于遍历全部 TLV */

STRUCT_PACKED image_version {    /**< 镜像版本号 */
    uint8_t iv_major;      /**< 主版本号 */
    uint8_t iv_minor;      /**< 次版本号 */
    uint16_t iv_revision;  /**< 修订号 */
    uint32_t iv_build_num; /**< 构建号 */
};  

struct image_dependency {    /**< 镜像依赖项 */
    uint8_t image_id;                        /**< 被依赖镜像的索引（从 0 开始） */
    uint8_t _pad1;                           /**< 填充保留字段 */
    uint16_t _pad2;                           /**< 填充保留字段 */
    struct image_version image_min_version;  /**< 满足该依赖所必须具备的最低固件版本 */
};  

/** 镜像头。所有字段均为小端字节序。 */
STRUCT_PACKED image_header {    /**< 镜像头 */
    uint32_t ih_magic;             /**< 镜像魔数，取值为 IMAGE_MAGIC */
    uint32_t ih_load_addr;        /**< RAM 加载地址，或镜像对应的 ROM 固定地址 */
    uint16_t ih_hdr_size;         /**< 镜像头大小（字节），也是镜像体的起始偏移 */
    uint16_t ih_protect_tlv_size; /**< 受保护 TLV 区域的大小（字节），为 0 表示无受保护 TLV */
    uint32_t ih_img_size;         /**< 镜像体大小（字节），不含镜像头 */
    uint32_t ih_flags;            /**< 镜像标志位，取值见 IMAGE_F_[...] 宏 */
    struct image_version ih_ver;  /**< 镜像版本号 */
    uint32_t _pad1;               /**< 填充保留字段 */
};

/** TLV 信息头（TLV 区域起始处）。所有字段均为小端字节序。 */
STRUCT_PACKED image_tlv_info {    /**< TLV 信息头 */
    uint16_t it_magic;   /**< TLV 区域魔数，IMAGE_TLV_INFO_MAGIC 或 IMAGE_TLV_PROT_INFO_MAGIC */
    uint16_t it_tlv_tot; /**< TLV 区域总大小（字节），包含本信息头自身 */
};

/** 镜像尾部单条 TLV 的格式。所有字段均为小端字节序。 */
STRUCT_PACKED image_tlv {    /**< TLV 格式 */
    uint16_t it_type; /**< TLV 类型，取值见 IMAGE_TLV_[...] 宏 */
    uint16_t it_len;  /**< TLV 数据长度（字节），不含 TLV 头自身 */
};

#define ENCRYPTIONFLAGS (IMAGE_F_ENCRYPTED_AES128 | IMAGE_F_ENCRYPTED_AES256)
#define IS_ENCRYPTED(hdr) (((hdr)->ih_flags & IMAGE_F_ENCRYPTED_AES128) \
                        || ((hdr)->ih_flags & IMAGE_F_ENCRYPTED_AES256))
#define MUST_DECRYPT(fap, idx, hdr) \
    (flash_area_get_id(fap) == FLASH_AREA_IMAGE_SECONDARY(idx) && IS_ENCRYPTED(hdr))

#define COMPRESSIONFLAGS (IMAGE_F_COMPRESSED_LZMA1 | IMAGE_F_COMPRESSED_LZMA2 \
                          | IMAGE_F_COMPRESSED_ARM_THUMB_FLT)
#define IS_COMPRESSED(hdr) ((hdr)->ih_flags & COMPRESSIONFLAGS)
#define MUST_DECOMPRESS(fap, idx, hdr) \
    (flash_area_get_id(fap) == FLASH_AREA_IMAGE_SECONDARY(idx) && IS_COMPRESSED(hdr))

_Static_assert(sizeof(struct image_header) == IMAGE_HEADER_SIZE,
               "struct image_header not required size");

struct boot_loader_state;
struct flash_area;

fih_ret bootutil_img_validate(struct boot_loader_state *state,
                              struct image_header *hdr,
                              const struct flash_area *fap,
                              uint8_t *tmp_buf, uint32_t tmp_buf_sz,
                              uint8_t *seed, int seed_len, uint8_t *out_hash
);

struct image_tlv_iter {
    const struct image_header *hdr;
    const struct flash_area *fap;
    uint16_t type;
    bool prot;
    uint32_t prot_end;
    uint32_t tlv_off;
    uint32_t tlv_end;
#if defined(MCUBOOT_SWAP_USING_OFFSET)
    uint32_t start_off;
#endif
};

int bootutil_tlv_iter_begin(struct image_tlv_iter *it,
                            const struct image_header *hdr,
                            const struct flash_area *fap, uint16_t type,
                            bool prot);
int bootutil_tlv_iter_next(struct image_tlv_iter *it, uint32_t *off,
                           uint16_t *len, uint16_t *type);
int bootutil_tlv_iter_is_prot(struct image_tlv_iter *it, uint32_t off);

int32_t bootutil_get_img_security_cnt(struct boot_loader_state *state, int slot,
                                      const struct flash_area *fap,
                                      uint32_t *img_security_cnt);

#if !defined(MCUBOOT_HW_KEY)
int bootutil_find_key(uint8_t *keyhash, uint8_t keyhash_len);
#else
int bootutil_find_key(uint8_t image_index, uint8_t *key, uint16_t key_len);
#endif

int
bootutil_img_hash(struct boot_loader_state *state,
                  struct image_header *hdr, const struct flash_area *fap,
                  uint8_t *tmp_buf, uint32_t tmp_buf_sz, uint8_t *hash_result,
                  uint8_t *seed, int seed_len
                 );

#ifdef __cplusplus
}
#endif

#endif
