/*
 * STM32F407VGT6 bare-metal port of MCUboot -- flash area identifiers
 * and partition layout.
 *
 * 1 MB flash, non-uniform sectors:
 *   sec 0-3  : 4 x 16 KB   0x08000000 - 0x0800FFFF
 *   sec 4    : 1 x 64 KB   0x08010000 - 0x0801FFFF
 *   sec 5-11 : 7 x 128 KB  0x08020000 - 0x080FFFFF
 *
 * Partitioning (swap using scratch):
 *   Bootloader : sec 0-4    128 KB @ 0x08000000
 *   Primary    : sec 5-7    384 KB @ 0x08020000
 *   Secondary  : sec 8-10   384 KB @ 0x08080000
 *   Scratch    : sec 11     128 KB @ 0x080E0000
 */
#ifndef __SYSFLASH_H__
#define __SYSFLASH_H__

/* Needed here so the MCUBOOT_IMAGE_NUMBER check below always sees the
 * configured value, regardless of which file includes sysflash.h. */
#include "mcuboot_config/mcuboot_config.h"

/* Flash device id for the internal STM32F4 flash. */
#define FLASH_DEVICE_INTERNAL_FLASH      0

/* Flash area identifiers. */
#define FLASH_AREA_BOOTLOADER            0
#define FLASH_AREA_IMAGE_0               1
#define FLASH_AREA_IMAGE_1               2
#define FLASH_AREA_IMAGE_SCRATCH         3

/* Physical layout (offsets relative to 0x08000000). */
#define STM32_FLASH_BASE                 0x08000000UL

#define BOOTLOADER_AREA_OFFSET           0x00000000UL
#define BOOTLOADER_AREA_SIZE             0x00020000UL   /* 128 KB */

#define PRIMARY_SLOT_AREA_OFFSET         0x00020000UL   /* 384 KB */
#define PRIMARY_SLOT_AREA_SIZE           0x00060000UL

#define SECONDARY_SLOT_AREA_OFFSET       0x00080000UL   /* 384 KB */
#define SECONDARY_SLOT_AREA_SIZE         0x00060000UL

#define SCRATCH_AREA_OFFSET              0x000E0000UL   /* 128 KB */
#define SCRATCH_AREA_SIZE                0x00020000UL

/* Application image header size. The application vector table starts at
 * PRIMARY_SLOT_AREA_OFFSET + MCUBOOT_APP_HEADER_SIZE within the flash
 * (0x08020000 + 0x200 = 0x08020200), which satisfies the VTOR 512-byte
 * alignment requirement. Must match imgtool `--header-size`. */
#define MCUBOOT_APP_HEADER_SIZE          0x200

#if (MCUBOOT_IMAGE_NUMBER == 1)
#define FLASH_AREA_IMAGE_PRIMARY(x)      (((x) == 0) ? FLASH_AREA_IMAGE_0 : \
                                                  FLASH_AREA_IMAGE_0)
#define FLASH_AREA_IMAGE_SECONDARY(x)    (((x) == 0) ? FLASH_AREA_IMAGE_1 : \
                                                  FLASH_AREA_IMAGE_1)
#else
#error "This port only supports MCUBOOT_IMAGE_NUMBER == 1"
#endif

#endif /* __SYSFLASH_H__ */
