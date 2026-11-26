/*
 * Last-resort fault handling. See app_fault.h.
 */
#include "app_fault.h"

#include "main.h"

__attribute__((noreturn)) void app_fault_reset(void)
{
    __disable_irq();
    NVIC_SystemReset();
}
