/*
 * MCUboot anti-rollback security counter for STM32F407.
 *
 * The counter is stored in the 512-byte OTP area at 0x1FFF7800 using a
 * unary encoding: bit N is programmed (cleared to 0) when the counter
 * reaches N + 1. Reading the counter means counting the contiguous run
 * of cleared bits starting at bit 0 (LSB of the first byte).
 *
 * This gives 4096 increments (one OTA confirmation each), survives power
 * loss, cannot be erased, and a partially programmed bit can only make
 * the counter skip forward, never go backwards. Bits are never re-set
 * (OTP can only be programmed from 1 to 0).
 */
#include <stddef.h>
#include <stdint.h>

#include "stm32f4xx_hal.h"
#include "bootutil/fault_injection_hardening.h"
#include "bootutil/security_cnt.h"

#define OTP_BASE            0x1FFF7800UL
#define OTP_SIZE            512U
#define OTP_COUNTER_BITS    (OTP_SIZE * 8U)

#define OTP_SUPPORTED_IMAGE 0U

static uint32_t otp_counter_read(void)
{
    uint32_t count = 0U;
    uint32_t i;
    uint32_t bit;

    for (i = 0U; i < OTP_SIZE; i++) {
        uint8_t b = *(volatile const uint8_t *)(OTP_BASE + i);

        if (b == 0xFFU) {
            break;
        }
        for (bit = 0U; bit < 8U; bit++) {
            if ((b & (uint8_t)(1U << bit)) != 0U) {
                return count;
            }
            count++;
        }
    }
    return count;
}

static int otp_counter_write(uint32_t target)
{
    uint32_t cur = otp_counter_read();
    HAL_StatusTypeDef st = HAL_OK;

    if (target > OTP_COUNTER_BITS) {
        return -1;
    }
    if (target <= cur) {
        return 0;
    }

    __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_EOP | FLASH_FLAG_OPERR |
                           FLASH_FLAG_WRPERR | FLASH_FLAG_PGAERR |
                           FLASH_FLAG_PGPERR | FLASH_FLAG_PGSERR);
    HAL_FLASH_Unlock();

    while (cur < target) {
        uint32_t addr = OTP_BASE + (cur / 8U);
        uint8_t bit = (uint8_t)(cur % 8U);
        uint8_t old = *(volatile const uint8_t *)addr;
        uint8_t val = (uint8_t)(old & (uint8_t)~(1U << bit));

        if (val != old) {
            st = HAL_FLASH_Program(FLASH_TYPEPROGRAM_BYTE, addr, val);
            if (st != HAL_OK) {
                break;
            }
        }
        cur++;
    }

    HAL_FLASH_Lock();
    return (st == HAL_OK) ? 0 : -1;
}

fih_ret boot_nv_security_counter_init(void)
{
    return FIH_SUCCESS;
}

fih_ret boot_nv_security_counter_get(uint32_t image_id, fih_int *security_cnt)
{
    if (security_cnt == NULL || image_id != OTP_SUPPORTED_IMAGE) {
        return FIH_FAILURE;
    }
    *security_cnt = fih_int_encode((int)otp_counter_read());
    return FIH_SUCCESS;
}

int32_t boot_nv_security_counter_update(uint32_t image_id,
                                        uint32_t img_security_cnt)
{
    if (image_id != OTP_SUPPORTED_IMAGE ||
        img_security_cnt > OTP_COUNTER_BITS) {
        return -1;
    }
    return (int32_t)otp_counter_write(img_security_cnt);
}

fih_ret boot_nv_security_counter_is_update_possible(uint32_t image_id,
                                                    uint32_t img_security_cnt)
{
    if (image_id != OTP_SUPPORTED_IMAGE ||
        img_security_cnt > OTP_COUNTER_BITS) {
        return FIH_FAILURE;
    }
    return FIH_SUCCESS;
}
