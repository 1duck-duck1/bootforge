/*
 * STM32F407 bare-metal port of MCUboot -- logging to USART2.
 *
 * All MCUBOOT_LOG_* macros funnel into boot_log_printf(), implemented
 * in boot_log.c (vsnprintf + blocking HAL_UART_Transmit).
 */
#ifndef __MCUBOOT_LOGGING_H
#define __MCUBOOT_LOGGING_H

#include <stdio.h>

#define MCUBOOT_LOG_LEVEL_OFF      0
#define MCUBOOT_LOG_LEVEL_ERROR    1
#define MCUBOOT_LOG_LEVEL_WARNING  2
#define MCUBOOT_LOG_LEVEL_INFO     3
#define MCUBOOT_LOG_LEVEL_DEBUG    4

#ifndef MCUBOOT_LOG_LEVEL
#define MCUBOOT_LOG_LEVEL MCUBOOT_LOG_LEVEL_INFO
#endif

void boot_log_printf(const char *fmt, ...);

#if MCUBOOT_LOG_LEVEL >= MCUBOOT_LOG_LEVEL_ERROR
#define MCUBOOT_LOG_ERR(_fmt, ...)   boot_log_printf("[ERR] " _fmt "\r\n", ##__VA_ARGS__)
#else
#define MCUBOOT_LOG_ERR(...) do { } while (0)
#endif

#if MCUBOOT_LOG_LEVEL >= MCUBOOT_LOG_LEVEL_WARNING
#define MCUBOOT_LOG_WRN(_fmt, ...)   boot_log_printf("[WRN] " _fmt "\r\n", ##__VA_ARGS__)
#else
#define MCUBOOT_LOG_WRN(...) do { } while (0)
#endif

#if MCUBOOT_LOG_LEVEL >= MCUBOOT_LOG_LEVEL_INFO
#define MCUBOOT_LOG_INF(_fmt, ...)   boot_log_printf("[INF] " _fmt "\r\n", ##__VA_ARGS__)
#else
#define MCUBOOT_LOG_INF(...) do { } while (0)
#endif

#if MCUBOOT_LOG_LEVEL >= MCUBOOT_LOG_LEVEL_DEBUG
#define MCUBOOT_LOG_DBG(_fmt, ...)   boot_log_printf("[DBG] " _fmt "\r\n", ##__VA_ARGS__)
#else
#define MCUBOOT_LOG_DBG(...) do { } while (0)
#endif

#define MCUBOOT_LOG_MODULE_DECLARE(...)
#define MCUBOOT_LOG_MODULE_REGISTER(...)

#endif /* __MCUBOOT_LOGGING_H */
