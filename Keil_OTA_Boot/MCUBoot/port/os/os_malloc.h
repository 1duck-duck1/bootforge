/*
 * Bare-metal stub of the Mynewt allocator header.
 *
 * Upstream loader.c includes <os/os_malloc.h> in swap mode. This port
 * never calls the allocation functions (verified by grep over the
 * compiled bootutil sources), but the include must resolve. If any
 * future code path does call them, the calls map onto the C library
 * heap (Heap_Size in startup_stm32f407xx.s).
 */
#ifndef __OS_MALLOC_STUB_H__
#define __OS_MALLOC_STUB_H__

#include <stdlib.h>

#define os_malloc(s)     malloc(s)
#define os_free(p)       free(p)
#define os_realloc(p, s) realloc((p), (s))

#endif /* __OS_MALLOC_STUB_H__ */
