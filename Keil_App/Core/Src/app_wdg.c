/*
 * Independent watchdog for the application. See app_wdg.h.
 */
#include "app_wdg.h"

#include "main.h"

/* IWDG_PR encoding: 4 = LSI / 64. */
#define APP_WDG_PRESCALER   4U
/* 64 * 2000 / 32000 Hz = 4 s nominal. */
#define APP_WDG_RELOAD      2000U

void app_wdg_init(void)
{
    /* Freeze the counter while the core is halted by the debugger so
     * breakpoints during development do not reset the target. */
    __HAL_DBGMCU_FREEZE_IWDG();

    IWDG->KR = 0xCCCCU;   /* start; the IWDG enables the LSI itself */
    IWDG->KR = 0x5555U;   /* allow PR/RLR writes */
    IWDG->PR = APP_WDG_PRESCALER;
    IWDG->RLR = APP_WDG_RELOAD;

    /* Wait until the prescaler and reload updates are applied. */
    while (IWDG->SR != 0U) {
    }

    IWDG->KR = 0xAAAAU;   /* reload */
}

void app_wdg_feed(void)
{
    IWDG->KR = 0xAAAAU;
}
