/*
 * Independent watchdog for the application.
 *
 * Driven at register level so the HAL IWDG module does not have to be added
 * to the project. Timeout is about 4 s at the nominal 32 kHz LSI; the LSI
 * tolerance widens that range, which is fine for a main-loop heartbeat.
 */
#ifndef __APP_WDG_H__
#define __APP_WDG_H__

/* Start the IWDG. Once started it cannot be stopped by software. */
void app_wdg_init(void);

/* Reload the counter; call at least once per timeout period. */
void app_wdg_feed(void);

#endif /* __APP_WDG_H__ */
