/*
 * Application-side image confirmation policy.
 *
 * MCUboot boots a TEST image with the image_ok trailer flag cleared. Unless
 * the application calls boot_set_confirmed() before the next reset, MCUboot
 * reverts to the previous image. This module owns that decision:
 *
 *   - it only acts when boot_swap_type() == BOOT_SWAP_TYPE_REVERT, i.e. the
 *     running image is the unconfirmed test image;
 *   - it waits for app_confirm_mark_ready() (application self-test passed),
 *     bounded by APP_CONFIRM_READY_TIMEOUT_MS;
 *   - then requires APP_CONFIRM_SETTLE_MS of healthy runtime;
 *   - finally writes image_ok through boot_set_confirmed().
 *
 * A timeout, app_confirm_mark_failed() or a failed flash write resets the MCU
 * so the next boot lets MCUboot perform the revert.
 */
#ifndef __APP_CONFIRM_H__
#define __APP_CONFIRM_H__

#include <stdint.h>

/* Time the application gets to report itself ready after boot (ms). */
#ifndef APP_CONFIRM_READY_TIMEOUT_MS
#define APP_CONFIRM_READY_TIMEOUT_MS  30000U
#endif

/* Healthy runtime required before the image is marked good (ms). */
#ifndef APP_CONFIRM_SETTLE_MS
#define APP_CONFIRM_SETTLE_MS         10000U
#endif

/* Read the swap type once the MCUboot library is usable (after boot). */
void app_confirm_init(void);

/* Poll from the main loop; no-op unless a test image awaits confirmation. */
void app_confirm_poll(void);

/* Application self-test passed: start the settle timer. */
void app_confirm_mark_ready(void);

/*
 * Fatal application error. Resets the MCU when the running image is still
 * unconfirmed so MCUboot can revert; does nothing on a confirmed image.
 */
void app_confirm_mark_failed(void);

#endif /* __APP_CONFIRM_H__ */
