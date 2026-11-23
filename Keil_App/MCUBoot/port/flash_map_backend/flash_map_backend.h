/*
 * STM32F407 bare-metal port of MCUboot -- flash map backend interface.
 *
 * This is the port-owned contract required by boot/bootutil (see
 * docs/PORTING.md). The implementation lives in flash_map.c.
 */
#ifndef __FLASH_MAP_BACKEND_H__
#define __FLASH_MAP_BACKEND_H__

#include <stdint.h>
#include <inttypes.h>

/*
 * Structure describing an area on a flash device.
 *
 * Multiple flash devices may be available in the system, each of
 * which may have its own areas. For this reason, flash areas track
 * which flash device they are part of.
 */
struct flash_area {
    /* This flash area's ID; unique in the system. */
    uint8_t fa_id;

    /* ID of the flash device this area is a part of. */
    uint8_t fa_device_id;

    uint16_t pad16;

    /* This area's offset, relative to the beginning of its flash
     * device's storage. */
    uint32_t fa_off;

    /* This area's size, in bytes. */
    uint32_t fa_size;
};

static inline uint8_t flash_area_get_id(const struct flash_area *fa)
{
    return fa->fa_id;
}

static inline uint8_t flash_area_get_device_id(const struct flash_area *fa)
{
    return fa->fa_device_id;
}

static inline uint32_t flash_area_get_off(const struct flash_area *fa)
{
    return fa->fa_off;
}

static inline uint32_t flash_area_get_size(const struct flash_area *fa)
{
    return fa->fa_size;
}

/*
 * Structure describing a sector within a flash area.
 *
 * Each sector has an offset relative to the start of its flash area
 * (NOT relative to the start of its flash device), and a size. A
 * flash area may contain sectors with different sizes.
 */
struct flash_sector {
    /* Offset of this sector, from the start of its flash area. */
    uint32_t fs_off;

    /* Size of this sector, in bytes. */
    uint32_t fs_size;
};

static inline uint32_t flash_sector_get_off(const struct flash_sector *fs)
{
    return fs->fs_off;
}

static inline uint32_t flash_sector_get_size(const struct flash_sector *fs)
{
    return fs->fs_size;
}

/*
 * Retrieve a memory-mapped flash device's base address. On success, the
 * address will be stored in the value pointed to by ret. Returns 0 on
 * success, non-zero on failure.
 */
int flash_device_base(uint8_t fd_id, uintptr_t *ret);

/* Opens the area for use. id is one of the `fa_id`s. */
int flash_area_open(uint8_t id, const struct flash_area **fa);
void flash_area_close(const struct flash_area *fa);

/* Reads `len` bytes of flash memory at `off` to the buffer at `dst`. */
int flash_area_read(const struct flash_area *fa, uint32_t off, void *dst,
                    uint32_t len);

/* Writes `len` bytes of flash memory at `off` from the buffer at `src`. */
int flash_area_write(const struct flash_area *fa, uint32_t off,
                     const void *src, uint32_t len);

/* Erases `len` bytes of flash memory at `off`. */
int flash_area_erase(const struct flash_area *fa, uint32_t off, uint32_t len);

/* Returns this `flash_area`s alignment (min write granularity). */
uint32_t flash_area_align(const struct flash_area *fa);

/* Returns the `fa_id` for slot, where slot is 0 (primary) or 1 (secondary). */
int flash_area_id_from_image_slot(int slot);
int flash_area_id_from_multi_image_slot(int image_index, int slot);
int flash_area_id_to_multi_image_slot(int image_index, int area_id);

/* Initializes an array of flash_sector elements for the area's sectors. */
int flash_area_get_sectors(int fa_id, uint32_t *cnt,
                           struct flash_sector *ret);

/*
 * Retrieves the sector that contains the given area-relative offset.
 * Fills sector->fs_off (area-relative) and sector->fs_size. Returns 0
 * on success, negative errno on failure.
 */
int flash_area_get_sector(const struct flash_area *fa, uint32_t off,
                          struct flash_sector *sector);

/*
 * Returns the value expected to be read when accessing any erased
 * flash byte.
 */
uint8_t flash_area_erased_val(const struct flash_area *fa);

/*
 * Reads len bytes from off, and checks if the read data is erased.
 * Returns 1 if erased, 0 if non-erased, and -1 on failure.
 */
int flash_area_read_is_empty(const struct flash_area *fa, uint32_t off,
                             void *dst, uint32_t len);

#endif /* __FLASH_MAP_BACKEND_H__ */
