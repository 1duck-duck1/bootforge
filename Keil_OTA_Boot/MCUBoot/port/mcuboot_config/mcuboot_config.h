/*
 * STM32F407VGT6 bare-metal port of MCUboot -- configuration.
 *
 * Flash layout (1 MB, non-uniform sectors):
 *   Bootloader : 0x08000000 .. 0x0801FFFF  (128 KB, sectors 0-4)
 *   Primary    : 0x08020000 .. 0x0807FFFF  (384 KB, sectors 5-7)
 *   Secondary  : 0x08080000 .. 0x080DFFFF  (384 KB, sectors 8-10)
 *   Scratch    : 0x080E0000 .. 0x080FFFFF  (128 KB, sector 11)
 *
 * Upgrade mode: default A/B swap using scratch (test / revert supported).
 */
#ifndef __MCUBOOT_CONFIG_H
#define __MCUBOOT_CONFIG_H

/* -------------------------------------------------------------------- *
 *  Signature type -- exactly one must be enabled.
 * -------------------------------------------------------------------- */
#define MCUBOOT_SIGN_EC256                    /* ECDSA P-256 + SHA-256 */

/* -------------------------------------------------------------------- *
 *  Crypto backend -- exactly one must be enabled.
 *  tinycrypt sources are in MCUBoot/tinycrypt (self-contained, no malloc).
 * -------------------------------------------------------------------- */
#define MCUBOOT_USE_TINYCRYPT

/* -------------------------------------------------------------------- *
 *  Upgrade policy
 *
 *  Default (nothing defined here): A/B swap using scratch -> supports
 *  test upgrade, confirmation and automatic revert.
 *
 *  For simplest first bring-up, un-comment MCUBOOT_OVERWRITE_ONLY:
 *  no rollback, secondary simply overwrites primary.
 * -------------------------------------------------------------------- */
/* #define MCUBOOT_OVERWRITE_ONLY */

/* Verify the primary slot image on every boot (recommended). */
#define MCUBOOT_VALIDATE_PRIMARY_SLOT

/* -------------------------------------------------------------------- *
 *  Anti-rollback (downgrade protection)
 *
 *  Each signed image carries a monotonic security counter in the
 *  signature-protected TLV area (imgtool --security-counter N). The
 *  bootloader compares it with the device value stored in OTP and
 *  refuses images whose counter is lower.
 *
 *  The counter is updated by MCUboot only after a test image has been
 *  confirmed, so a failed upgrade can still revert to the previous image.
 * -------------------------------------------------------------------- */
#define MCUBOOT_HW_ROLLBACK_PROT
/* Reject counters that cannot be stored in the OTP counter window. */
#define MCUBOOT_HW_ROLLBACK_PROT_COUNTER_LIMITED

/* -------------------------------------------------------------------- *
 *  Flash abstraction
 * -------------------------------------------------------------------- */

/* Port provides flash_area_get_sectors() with the real (non-uniform)
 * STM32F4 sector table. Must be enabled on this target. */
#define MCUBOOT_USE_FLASH_AREA_GET_SECTORS

#define MCUBOOT_DEV_WITH_ERASE

/* Max number of flash sectors reported per image slot. The largest slot
 * here spans 3 physical sectors (3 x 128 KB); 16 leaves plenty of margin
 * and keeps boot_sector_buffer small. */
#ifndef MCUBOOT_MAX_IMG_SECTORS
#define MCUBOOT_MAX_IMG_SECTORS 16
#endif

/* Number of independently updatable images. */
#ifndef MCUBOOT_IMAGE_NUMBER
#define MCUBOOT_IMAGE_NUMBER 1
#endif

/* -------------------------------------------------------------------- *
 *  Logging -> see mcuboot_logging.h (routed to USART2)
 * -------------------------------------------------------------------- */
#define MCUBOOT_HAVE_LOGGING 1

/* -------------------------------------------------------------------- *
 *  Assertions -> see mcuboot_assert.h
 * -------------------------------------------------------------------- */
#define MCUBOOT_HAVE_ASSERT_H

/* -------------------------------------------------------------------- *
 *  Platform hooks
 * -------------------------------------------------------------------- */

/* No watchdog during boot for now. NOTE: when a watchdog is added, its
 * timeout must exceed the worst-case 128 KB sector erase time (~4 s),
 * because the CPU stalls during flash erase and cannot feed it. */
#define MCUBOOT_WATCHDOG_FEED()   do { } while (0)

#define MCUBOOT_CPU_IDLE()        do { } while (0)

#endif /* __MCUBOOT_CONFIG_H */
