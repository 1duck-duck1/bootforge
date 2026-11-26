/*
 * App-side USART2 console and bootloader OTA handshake.
 *
 * Serial firmware transfer lives in the bootloader (Keil_OTA_Boot/Core/Src/
 * boot_ota.c). This module only:
 *   - delivers console bytes received on USART2 (115200 8N1) to the caller;
 *   - watches for the "OTA\n" command from the host, then writes
 *     APP_BOOT_OTA_MAGIC to an RTC backup register and resets, so the
 *     bootloader enters its serial OTA server.
 */
#ifndef __APP_OTA_H__
#define __APP_OTA_H__

#include <stdint.h>

/* Must match BOOT_OTA_REQUEST_MAGIC in the bootloader project. */
#define APP_BOOT_OTA_MAGIC  0x4F544152UL  /* 'OTAR' */

/* Start DMA reception and reset the protocol state. */
void app_ota_init(void);

/*
 * Drain buffered UART bytes. A byte received outside the "OTA\n" handshake
 * is returned through *ch as a console command.
 * Returns 1 when *ch is valid, 0 when no text byte is pending.
 */
int app_ota_poll(uint8_t *ch);

#endif /* __APP_OTA_H__ */
