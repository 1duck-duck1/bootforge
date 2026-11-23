/*
 * STM32F407 bare-metal port of MCUboot -- log output on USART2.
 *
 * Uses vsnprintf (no semihosting involved) and a blocking UART transmit,
 * which is safe in the bootloader's single-threaded context.
 */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "stm32f4xx_hal.h"
#include "usart.h"
#include "mcuboot_config/mcuboot_logging.h"

#define BOOT_LOG_BUF_SIZE 128

void boot_log_printf(const char *fmt, ...)
{
    static char buf[BOOT_LOG_BUF_SIZE];
    va_list ap;
    int len;

    va_start(ap, fmt);
    len = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    if (len <= 0) {
        return;
    }
    if ((size_t)len >= sizeof(buf)) {
        len = (int)sizeof(buf) - 1;
    }

    (void)HAL_UART_Transmit(&huart2, (uint8_t *)buf, (uint16_t)len, 1000);
}
