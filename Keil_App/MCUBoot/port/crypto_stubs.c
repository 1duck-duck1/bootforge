/*
 * Link-time stubs for symbols referenced by the vendored crypto stack
 * but never executed on this bootloader's code paths.
 *
 * - default_CSPRNG: tinycrypt's ecc.c initializes its RNG function
 *   pointer to this symbol. Signature verification (uECC_verify) is
 *   deterministic and never invokes the RNG; only key generation does,
 *   and the bootloader never generates keys.
 *
 * - mbedtls_mpi_read_binary: referenced by mbedtls_asn1_get_mpi() in
 *   the vendored ASN.1 parser. The ECDSA code parses the SPKI key and
 *   the r/s signature with raw get_tag/get_alg calls and never uses
 *   get_mpi.
 *
 * Both return failure so any accidental future use fails loudly
 * instead of silently producing wrong results.
 */

#include <stddef.h>
#include <stdint.h>

#include "mbedtls/bignum.h"

/* tinycrypt contract: returns 1 on success, 0 on failure. */
int default_CSPRNG(uint8_t *dest, unsigned int size)
{
    (void)dest;
    (void)size;
    return 0;
}

/* mbedtls contract: returns 0 on success, negative MBEDTLS_ERR on error. */
int mbedtls_mpi_read_binary(mbedtls_mpi *X,
                            const unsigned char *buf, size_t buflen)
{
    (void)X;
    (void)buf;
    (void)buflen;
    return -0x007A; /* MBEDTLS_ERR_ASN1_ALLOC_FAILED style: nonzero */
}
