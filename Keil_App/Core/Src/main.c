/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"
#include "usart.h"
#include "gpio.h"
#include "tim.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "bootutil/bootutil_public.h"
#include "mcuboot_config/mcuboot_logging.h"
#include "SEGGER_RTT.h"
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/

/* USER CODE BEGIN PV */
/* RTT 心跳计时（ms） */
static uint32_t last_rtt_beat = 0;
/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
/* USER CODE BEGIN PFP */
static void handle_command(uint8_t ch);
/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
/* 处理来自 UART 或 RTT 的单字符命令 */
static void handle_command(uint8_t ch)
{
  switch (ch)
  {
  case 'p':
    MCUBOOT_LOG_INF("boot_set_pending(test), rebooting...");
    if (boot_set_pending(false) == 0)
    {
      HAL_Delay(50);
      NVIC_SystemReset();
    }
    MCUBOOT_LOG_ERR("boot_set_pending failed");
    break;
  case 's':
  {
    /* MCUboot 常量：1=none 2=test 3=perm 4=revert 5=fail（bootutil_public.h） */
    const char *desc;
    switch (boot_swap_type())
    {
    case 1: desc = "none - no pending swap"; break;
    case 2: desc = "test - image pending test upgrade"; break;
    case 3: desc = "perm - image pending permanent upgrade"; break;
    case 4: desc = "revert - test image awaiting confirmation"; break;
    case 5: desc = "fail - swap failed"; break;
    default: desc = "unknown"; break;
    }
    MCUBOOT_LOG_INF("boot_swap_type: %s", desc);
    break;
  }
  case 't':
    /* 诊断：HAL_GetTick 停滞说明 SysTick 中断未运行 */
    MCUBOOT_LOG_INF("tick=%u", (unsigned)HAL_GetTick());
    break;
  default:
    break;
  }
}
/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */
  /* MCUboot 跳转前执行了 __disable_irq()，APP 必须重新开中断，
   * 否则 SysTick 中断被屏蔽，HAL_GetTick()/HAL_Delay() 永久停摆。 */
  __enable_irq();
  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  /* USER CODE BEGIN 2 */
  {
    int rc;

    /* Restore user peripheral: TIM2 timebase (1 kHz). */
    MX_TIM2_Init();
    HAL_TIM_Base_Start(&htim2);

    /* SEGGER RTT: 控制块由上位机按 RAM 扫描 "SEGGER RTT" 自动定位。 */
    SEGGER_RTT_Init();
    (void)SEGGER_RTT_printf(0, "\r\n=== Keil_OTA App RTT ready (build %s %s) ===\r\n",
                            __DATE__, __TIME__);
    (void)SEGGER_RTT_WriteString(0, "RTT up/down channel 0 ready, keys: [p] pending+reboot, [s] swap status, [t] tick\r\n");

    MCUBOOT_LOG_INF("=== Keil_OTA App v1.0.0 (build "__DATE__" "__TIME__") ===");
    MCUBOOT_LOG_INF("Running from primary slot, entry 0x08020200");

    /* Mark this image as good. Skipped automatically when already
     * confirmed. Build with APP_AUTO_CONFIRM 0 to test MCUboot's
     * automatic revert of an unconfirmed test image. */
#define APP_AUTO_CONFIRM 1
#if APP_AUTO_CONFIRM
    rc = boot_set_confirmed();
    MCUBOOT_LOG_INF("boot_set_confirmed rc=%d", rc);
#endif

    MCUBOOT_LOG_INF("keys: [p] mark pending + reboot, [s] swap status, [t] tick");
  }
  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    uint8_t ch;

    /* UART 命令 */
    if (HAL_UART_Receive(&huart2, &ch, 1, 50) == HAL_OK)
    {
      handle_command(ch);
    }

    /* RTT 下行命令：上位机 RTT 面板发送的字符走同一套处理 */
    if (SEGGER_RTT_HasKey())
    {
      int key = SEGGER_RTT_GetKey();
      if (key >= 0)
      {
        (void)SEGGER_RTT_printf(0, "RTT rx: '%c'\r\n", (char)key);
        handle_command((uint8_t)key);
      }
    }

    /* 1 Hz 心跳，便于确认 RTT 链路工作正常 */
    if (HAL_GetTick() - last_rtt_beat >= 1000U)
    {
      last_rtt_beat = HAL_GetTick();
      (void)SEGGER_RTT_printf(0, "[%u ms] RTT alive\r\n", (unsigned)last_rtt_beat);
    }
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  RCC_OscInitStruct.HSEState = RCC_HSE_ON;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  RCC_OscInitStruct.PLL.PLLM = 4;
  RCC_OscInitStruct.PLL.PLLN = 168;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
  RCC_OscInitStruct.PLL.PLLQ = 4;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK)
  {
    Error_Handler();
  }
}

/* USER CODE BEGIN 4 */

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}

#ifdef  USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
