/*
 * STM32F407 bare-metal port of MCUboot -- assertions.
 * A failed assertion halts the bootloader; it must never continue.
 */
#ifndef __MCUBOOT_ASSERT_H
#define __MCUBOOT_ASSERT_H

#include <stdint.h>
#include "mcuboot_config/mcuboot_logging.h"

#define assert(__e) \
    do { \
        if (!(__e)) { \
            MCUBOOT_LOG_ERR("ASSERT failed: %s:%d", __FILE__, __LINE__); \
            while (1) { } \
        } \
    } while (0)

#endif /* __MCUBOOT_ASSERT_H */
