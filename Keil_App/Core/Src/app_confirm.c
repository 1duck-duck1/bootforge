/*
 * Application-side image confirmation policy. See app_confirm.h.
 */
#include "app_confirm.h"

#include "main.h"
#include "bootutil/bootutil_public.h"
#include "mcuboot_config/mcuboot_logging.h"

typedef enum {
    APP_CONFIRM_IDLE = 0,    /* nothing to confirm */
    APP_CONFIRM_WAIT_READY,  /* test image, waiting for the self-test */
    APP_CONFIRM_SETTLING     /* self-test passed, waiting settle time */
} app_confirm_state_t;

static app_confirm_state_t state;
static uint32_t state_start;

/* Without confirmation MCUboot reverts on the next reset, so resetting is
 * the failure action rather than staying in an endless error loop. */
static __attribute__((noreturn)) void app_confirm_reset(void)
{
    MCUBOOT_LOG_ERR("confirmation failed, resetting for MCUboot revert");
    HAL_Delay(20);
    NVIC_SystemReset();
}

void app_confirm_init(void)
{
    int swap_type = boot_swap_type();

    if (swap_type == BOOT_SWAP_TYPE_REVERT) {
        state = APP_CONFIRM_WAIT_READY;
        state_start = HAL_GetTick();
        MCUBOOT_LOG_INF("test image running, ready timeout %u ms, settle %u ms",
                        (unsigned)APP_CONFIRM_READY_TIMEOUT_MS,
                        (unsigned)APP_CONFIRM_SETTLE_MS);
    } else {
        state = APP_CONFIRM_IDLE;
        MCUBOOT_LOG_INF("swap_type=%d, no confirmation pending", swap_type);
    }
}

void app_confirm_mark_ready(void)
{
    if (state != APP_CONFIRM_WAIT_READY) {
        return;
    }

    /* Initialization may itself take long enough to miss the window. */
    if ((uint32_t)(HAL_GetTick() - state_start) >=
        APP_CONFIRM_READY_TIMEOUT_MS) {
        MCUBOOT_LOG_ERR("self-test finished too late (%u ms)",
                        (unsigned)APP_CONFIRM_READY_TIMEOUT_MS);
        app_confirm_reset();
    }

    state = APP_CONFIRM_SETTLING;
    state_start = HAL_GetTick();
    MCUBOOT_LOG_INF("self-test passed, confirming in %u ms",
                    (unsigned)APP_CONFIRM_SETTLE_MS);
}

void app_confirm_mark_failed(void)
{
    if (state == APP_CONFIRM_IDLE) {
        /* Reset here would only reboot-loop a confirmed image. */
        MCUBOOT_LOG_WRN("fatal error on a confirmed image, not resetting");
        return;
    }

    app_confirm_reset();
}

void app_confirm_poll(void)
{
    uint32_t elapsed;

    if (state == APP_CONFIRM_WAIT_READY) {
        elapsed = (uint32_t)(HAL_GetTick() - state_start);
        if (elapsed >= APP_CONFIRM_READY_TIMEOUT_MS) {
            MCUBOOT_LOG_ERR("self-test did not complete in %u ms",
                            (unsigned)APP_CONFIRM_READY_TIMEOUT_MS);
            app_confirm_reset();
        }
    } else if (state == APP_CONFIRM_SETTLING) {
        elapsed = (uint32_t)(HAL_GetTick() - state_start);
        if (elapsed >= APP_CONFIRM_SETTLE_MS) {
            if (boot_set_confirmed() != 0) {
                app_confirm_reset();
            }
            state = APP_CONFIRM_IDLE;
            MCUBOOT_LOG_INF("image confirmed");
        }
    }
}
