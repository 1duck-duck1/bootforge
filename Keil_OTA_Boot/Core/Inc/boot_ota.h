/**
  ******************************************************************************
  * @file    boot_ota.h
  * @brief   Bootloader-side serial OTA receiver.
  *
  * The application no longer receives firmware images. Instead, when the host
  * asks for an update the application only writes BOOT_OTA_REQUEST_MAGIC to an
  * RTC backup register and resets. The bootloader detects the flag, clears it
  * and serves the same 0x7E-framed protocol on USART2: the image is written
  * directly to the secondary slot, verified and marked pending.
  ******************************************************************************
  */
#ifndef __BOOT_OTA_H__
#define __BOOT_OTA_H__

#include <stdint.h>

/* Must match APP_BOOT_OTA_MAGIC in the application project. */
#define BOOT_OTA_REQUEST_MAGIC  0x4F544152UL  /* 'OTAR' */

/* How long the bootloader keeps the OTA server open after an application
 * request when no host traffic arrives (the app is valid, so it can still boot). */
#define BOOT_OTA_IDLE_TIMEOUT_MS  30000U

/* Return 1 when the application requested the bootloader OTA mode. */
int boot_ota_requested(void);

/* Clear the request flag so the next reset boots normally. */
void boot_ota_clear_request(void);

/**
  * @brief Serve the serial OTA protocol on USART2 until the session ends.
  * @param idle_timeout_ms  Time to wait without traffic before returning to the
  *                         caller so it can boot the existing image.
  *                         Pass 0 to wait forever (recovery mode: no bootable app).
  *
  * On APPLY the function marks the secondary image pending, sends the ACK and
  * resets the MCU; it does not return in that case.
  *
  * In normal (application-requested) mode the host may send an EXIT frame
  * after a QUERY to leave the OTA window immediately and boot the application.
  * EXIT is rejected in recovery mode (idle_timeout_ms == 0).
  */
void boot_ota_run(uint32_t idle_timeout_ms);

#endif /* __BOOT_OTA_H__ */
