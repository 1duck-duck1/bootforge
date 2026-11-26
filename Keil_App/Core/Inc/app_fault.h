/*
 * Last-resort fault handling.
 *
 * Faults are not logged here: the stack may be corrupt, and the only useful
 * reaction is a reset. A reset also gives MCUboot the chance to revert an
 * unconfirmed test image.
 */
#ifndef __APP_FAULT_H__
#define __APP_FAULT_H__

/* Never returns. */
__attribute__((noreturn)) void app_fault_reset(void);

#endif /* __APP_FAULT_H__ */
