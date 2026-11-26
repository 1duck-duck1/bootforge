/*
 * App-side USART2 console and bootloader OTA handshake.
 *
 * The serial firmware transfer now lives in the bootloader. This file only
 * receives console bytes over USART2 (DMA + IDLE) and watches for the
 * "OTA\n" command: on a match it writes a magic value to an RTC backup
 * register and resets, so the bootloader enters its serial OTA server.
 *
 * Keeping the handshake in the application means the host can request an
 * update without any boot-time listening window. If the application is
 * missing or cannot boot, the bootloader enters OTA mode on its own.
 */
#include <string.h>

#include "app_ota.h"
#include "main.h"
#include "usart.h"
#include "SEGGER_RTT.h"

/* ---------------------------------------------------------------------- */
/* Console reception                                                      */
/* ---------------------------------------------------------------------- */
#define APP_RX_RING_SIZE        4096U   /* must be a power of two */
#define APP_DMA_BUF_SIZE        2048U   /* USART2 RX circular DMA, power of two */

static uint8_t  dma_buf[APP_DMA_BUF_SIZE];
static volatile uint16_t dma_rd_pos;

static uint8_t  rx_ring[APP_RX_RING_SIZE];
static volatile uint16_t rx_head;
static volatile uint16_t rx_tail;

/* Handshake sequence sent by the host before the first OTA frame.
 * Uppercase so it cannot collide with the lowercase console commands. */
static const char hs_seq[] = "OTA\n";
static uint8_t hs_pos;

static void ring_push(uint8_t b)
{
    uint16_t next = (uint16_t)((rx_head + 1U) & (APP_RX_RING_SIZE - 1U));

    if (next != rx_tail) {
        rx_ring[rx_head] = b;
        rx_head = next;
    }
    /* Ring full: byte dropped. The console tolerates this. */
}

static int ring_pop(uint8_t *b)
{
    if (rx_tail == rx_head) {
        return 0;
    }
    *b = rx_ring[rx_tail];
    rx_tail = (uint16_t)((rx_tail + 1U) & (APP_RX_RING_SIZE - 1U));
    return 1;
}

/*
 * Copy the bytes the DMA has written since dma_rd_pos up to the absolute
 * write position `pos` (0..APP_DMA_BUF_SIZE) into the byte ring.
 * Called from USART (IDLE) and DMA (HT/TC) interrupt context; the DMA
 * stream has a higher NVIC priority than USART2, so mask interrupts while
 * updating the shared read position.
 */
static void app_dma_commit(uint16_t pos)
{
    uint16_t end = (pos >= APP_DMA_BUF_SIZE) ? (uint16_t)APP_DMA_BUF_SIZE : pos;
    uint16_t start = dma_rd_pos;
    uint16_t count;
    uint32_t primask = __get_PRIMASK();

    __disable_irq();
    /* Convert to a byte count before copying: when the DMA buffer wraps
     * (end < start) an "i != end" loop would spin forever. */
    if (end >= start) {
        count = (uint16_t)(end - start);
    } else {
        count = (uint16_t)(APP_DMA_BUF_SIZE - start + end);
    }
    while (count-- > 0U) {
        ring_push(dma_buf[start]);
        start = (uint16_t)((start + 1U) & (APP_DMA_BUF_SIZE - 1U));
    }
    dma_rd_pos = (end == APP_DMA_BUF_SIZE) ? 0U : end;
    __set_PRIMASK(primask);
}

/* ---------------------------------------------------------------------- */
/* Bootloader handshake                                                   */
/* ---------------------------------------------------------------------- */
static void request_boot_ota(void)
{
    __HAL_RCC_PWR_CLK_ENABLE();
    HAL_PWR_EnableBkUpAccess();
    RTC->BKP0R = APP_BOOT_OTA_MAGIC;

    (void)SEGGER_RTT_WriteString(0,
        "[ota] host handshake, rebooting into bootloader serial OTA\r\n");
    HAL_Delay(20);
    NVIC_SystemReset();
}

/* ---------------------------------------------------------------------- */
/* Public API                                                             */
/* ---------------------------------------------------------------------- */
void app_ota_init(void)
{
    rx_head = 0;
    rx_tail = 0;
    dma_rd_pos = 0;
    hs_pos = 0;

    /* Circular DMA reception + USART2 IDLE interrupt (handled by HAL). */
    (void)HAL_UARTEx_ReceiveToIdle_DMA(&huart2, dma_buf, APP_DMA_BUF_SIZE);
}

int app_ota_poll(uint8_t *ch)
{
    uint8_t b;

    while (ring_pop(&b)) {
        if (b == (uint8_t)hs_seq[hs_pos]) {
            hs_pos++;
            if (hs_seq[hs_pos] == '\0') {
                hs_pos = 0;
                request_boot_ota();
            }
        } else {
            hs_pos = (b == (uint8_t)hs_seq[0]) ? 1U : 0U;
        }

        *ch = b;
        return 1;
    }
    return 0;
}

/* ---------------------------------------------------------------------- */
/* HAL UART callbacks                                                     */
/* ---------------------------------------------------------------------- */

/* HT / TC / IDLE event: Size is the current DMA write position. */
void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Size)
{
    if (huart->Instance == USART2) {
        app_dma_commit(Size);
    }
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
    if (huart->Instance == USART2) {
        __HAL_UART_CLEAR_OREFLAG(huart);
        /* A DMA/UART error may have stopped reception; restart it. */
        if (HAL_UARTEx_ReceiveToIdle_DMA(huart, dma_buf, APP_DMA_BUF_SIZE)
            == HAL_OK) {
            dma_rd_pos = 0;
        }
    }
}
