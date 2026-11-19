/*
 * tlsshim: OpenSSL's libssl behind a tiny C API, as a WASI reactor module for the node
 * runtime's `tls`/`https` (other/node/tls.js). No sockets here: each connection's
 * ciphertext goes through two memory BIOs, and JavaScript moves it over the simulated
 * network. Everything returns plain ints so the JS side stays simple.
 */
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct {
  SSL *ssl;
  BIO *in, *out;
} conn_t;

static char errbuf[512];

static void set_err(const char *fallback) {
  unsigned long e = ERR_get_error();
  if (e) ERR_error_string_n(e, errbuf, sizeof errbuf);
  else snprintf(errbuf, sizeof errbuf, "%s", fallback);
  ERR_clear_error();
}

EXPORT(tb_malloc) void *tb_malloc(size_t n) { return malloc(n ? n : 1); }
EXPORT(tb_free) void tb_free(void *p) { free(p); }
EXPORT(tbtls_error) const char *tbtls_error(void) { return errbuf; }

EXPORT(tbtls_ctx_new) SSL_CTX *tbtls_ctx_new(int server) {
  SSL_CTX *c = SSL_CTX_new(server ? TLS_server_method() : TLS_client_method());
  if (!c) {
    set_err("SSL_CTX_new failed");
    return NULL;
  }
  SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);
  SSL_CTX_set_mode(c, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
  return c;
}

EXPORT(tbtls_ctx_free) void tbtls_ctx_free(SSL_CTX *c) { SSL_CTX_free(c); }

/* Certificate chain (leaf first, then intermediates) from PEM. */
EXPORT(tbtls_ctx_cert) int tbtls_ctx_cert(SSL_CTX *c, const char *pem, int len) {
  BIO *b = BIO_new_mem_buf(pem, len);
  X509 *leaf = PEM_read_bio_X509(b, NULL, NULL, NULL);
  int ok = leaf && SSL_CTX_use_certificate(c, leaf) == 1;
  X509_free(leaf);
  X509 *x;
  while (ok && (x = PEM_read_bio_X509(b, NULL, NULL, NULL)))
    if (SSL_CTX_add0_chain_cert(c, x) != 1) X509_free(x);
  ERR_clear_error(); /* the read past the last certificate */
  BIO_free(b);
  if (!ok) set_err("no certificate in PEM");
  return ok ? 0 : -1;
}

EXPORT(tbtls_ctx_key) int tbtls_ctx_key(SSL_CTX *c, const char *pem, int len) {
  BIO *b = BIO_new_mem_buf(pem, len);
  EVP_PKEY *k = PEM_read_bio_PrivateKey(b, NULL, NULL, NULL);
  BIO_free(b);
  int ok = k && SSL_CTX_use_PrivateKey(c, k) == 1 && SSL_CTX_check_private_key(c) == 1;
  EVP_PKEY_free(k);
  if (!ok) set_err("bad private key, or it doesn't match the certificate");
  return ok ? 0 : -1;
}

/* Trusted CAs (a PEM bundle); returns how many certificates were added. */
EXPORT(tbtls_ctx_ca) int tbtls_ctx_ca(SSL_CTX *c, const char *pem, int len) {
  BIO *b = BIO_new_mem_buf(pem, len);
  X509_STORE *st = SSL_CTX_get_cert_store(c);
  X509 *x;
  int n = 0;
  while ((x = PEM_read_bio_X509(b, NULL, NULL, NULL))) {
    if (X509_STORE_add_cert(st, x) == 1) n++;
    X509_free(x);
  }
  ERR_clear_error();
  BIO_free(b);
  return n;
}

/* mode: 0 none, 1 verify the peer (handshake fails on a bad chain), 2 also require a client cert. */
EXPORT(tbtls_ctx_verify) void tbtls_ctx_verify(SSL_CTX *c, int mode) {
  SSL_CTX_set_verify(c, mode == 0 ? SSL_VERIFY_NONE : SSL_VERIFY_PEER | (mode == 2 ? SSL_VERIFY_FAIL_IF_NO_PEER_CERT : 0), NULL);
}

/* ALPN for servers: prefer what the client offers among `protos` (wire format). */
static unsigned char alpn_server[64];
static unsigned alpn_server_len;
static int alpn_select(SSL *s, const unsigned char **out, unsigned char *outlen, const unsigned char *in, unsigned inlen, void *arg) {
  (void)s;
  (void)arg;
  if (SSL_select_next_proto((unsigned char **)out, outlen, alpn_server, alpn_server_len, in, inlen) == OPENSSL_NPN_NEGOTIATED) return SSL_TLSEXT_ERR_OK;
  return SSL_TLSEXT_ERR_NOACK;
}
EXPORT(tbtls_ctx_alpn) int tbtls_ctx_alpn(SSL_CTX *c, int server, const unsigned char *wire, int len) {
  if (len <= 0 || len > (int)sizeof alpn_server) return -1;
  if (server) {
    memcpy(alpn_server, wire, len);
    alpn_server_len = len;
    SSL_CTX_set_alpn_select_cb(c, alpn_select, NULL);
    return 0;
  }
  return SSL_CTX_set_alpn_protos(c, wire, len) == 0 ? 0 : -1;
}

/*
 * A connection. Clients: `host` is sent as SNI (unless it's an IP) and, when verifying,
 * checked against the certificate (DNS name or IP address).
 */
EXPORT(tbtls_new) conn_t *tbtls_new(SSL_CTX *c, int server, const char *host, int verify_host) {
  conn_t *t = calloc(1, sizeof *t);
  if (!t) return NULL;
  t->ssl = SSL_new(c);
  t->in = BIO_new(BIO_s_mem());
  t->out = BIO_new(BIO_s_mem());
  if (!t->ssl || !t->in || !t->out) {
    set_err("SSL_new failed");
    return NULL;
  }
  BIO_set_mem_eof_return(t->in, -1);
  SSL_set_bio(t->ssl, t->in, t->out);
  if (server) SSL_set_accept_state(t->ssl);
  else {
    SSL_set_connect_state(t->ssl);
    if (host && *host) {
      int is_ip = strspn(host, "0123456789.") == strlen(host) || strchr(host, ':');
      if (!is_ip) SSL_set_tlsext_host_name(t->ssl, host);
      if (verify_host) {
        if (is_ip) X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(t->ssl), host);
        else SSL_set1_host(t->ssl, host);
      }
    }
  }
  return t;
}

/* 1 done, 0 needs more data, -1 failed (tbtls_error / tbtls_verify_result say why). */
EXPORT(tbtls_handshake) int tbtls_handshake(conn_t *t) {
  int r = SSL_do_handshake(t->ssl);
  if (r == 1) return 1;
  int e = SSL_get_error(t->ssl, r);
  if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) return 0;
  set_err("handshake failed");
  return -1;
}

/* Ciphertext from the network. */
EXPORT(tbtls_feed) int tbtls_feed(conn_t *t, const void *p, int n) { return BIO_write(t->in, p, n); }
/* Ciphertext for the network. */
EXPORT(tbtls_out_pending) int tbtls_out_pending(conn_t *t) { return (int)BIO_ctrl_pending(t->out); }
EXPORT(tbtls_out_take) int tbtls_out_take(conn_t *t, void *p, int n) { return BIO_read(t->out, p, n); }

/* Plaintext: >0 bytes, -2 needs more data, 0 closed by the peer (close_notify), -1 error. */
EXPORT(tbtls_read) int tbtls_read(conn_t *t, void *p, int n) {
  int r = SSL_read(t->ssl, p, n);
  if (r > 0) return r;
  int e = SSL_get_error(t->ssl, r);
  if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) return -2;
  if (e == SSL_ERROR_ZERO_RETURN) return 0;
  set_err("read failed");
  return -1;
}

EXPORT(tbtls_write) int tbtls_write(conn_t *t, const void *p, int n) {
  int r = SSL_write(t->ssl, p, n);
  if (r > 0) return r;
  int e = SSL_get_error(t->ssl, r);
  if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) return -2;
  set_err("write failed");
  return -1;
}

EXPORT(tbtls_shutdown) void tbtls_shutdown(conn_t *t) { SSL_shutdown(t->ssl); }

EXPORT(tbtls_free) void tbtls_free(conn_t *t) {
  if (!t) return;
  SSL_free(t->ssl); /* frees both BIOs */
  free(t);
}

/* X509_V_OK (0) or the verification error, with its text. */
EXPORT(tbtls_verify_result) int tbtls_verify_result(conn_t *t) { return (int)SSL_get_verify_result(t->ssl); }
EXPORT(tbtls_verify_string) const char *tbtls_verify_string(int code) { return X509_verify_cert_error_string(code); }

/* "version\tcipher\talpn\tsubjectCN\tissuerCN\tissuerO\tnotAfter\tsubjectAltNames\tserialHex" for getPeerCertificate()/getProtocol(). */
static char info[2048];
static void name_entry(X509_NAME *n, int nid, char *out, size_t size) {
  out[0] = 0;
  if (n) X509_NAME_get_text_by_NID(n, nid, out, (int)size);
}
EXPORT(tbtls_info) const char *tbtls_info(conn_t *t) {
  const unsigned char *alpn = NULL;
  unsigned alen = 0;
  SSL_get0_alpn_selected(t->ssl, &alpn, &alen);
  char a[64] = "";
  if (alen && alen < sizeof a) memcpy(a, alpn, alen), a[alen] = 0;
  char scn[256] = "", icn[256] = "", io[256] = "", exp[64] = "", sans[768] = "", serial[80] = "";
  X509 *peer = SSL_get1_peer_certificate(t->ssl);
  if (peer) {
    name_entry(X509_get_subject_name(peer), NID_commonName, scn, sizeof scn);
    name_entry(X509_get_issuer_name(peer), NID_commonName, icn, sizeof icn);
    name_entry(X509_get_issuer_name(peer), NID_organizationName, io, sizeof io);
    BIO *b = BIO_new(BIO_s_mem());
    ASN1_TIME_print(b, X509_get0_notAfter(peer));
    int n = BIO_read(b, exp, sizeof exp - 1);
    exp[n > 0 ? n : 0] = 0;
    BIO_free(b);
    GENERAL_NAMES *gens = X509_get_ext_d2i(peer, NID_subject_alt_name, NULL, NULL);
    for (int i = 0; gens && i < sk_GENERAL_NAME_num(gens); i++) {
      GENERAL_NAME *g = sk_GENERAL_NAME_value(gens, i);
      if (g->type != GEN_DNS) continue;
      size_t used = strlen(sans);
      snprintf(sans + used, sizeof sans - used, "%sDNS:%s", used ? ", " : "", (const char *)ASN1_STRING_get0_data(g->d.dNSName));
    }
    GENERAL_NAMES_free(gens);
    BIGNUM *bn = ASN1_INTEGER_to_BN(X509_get0_serialNumber(peer), NULL);
    char *hex = bn ? BN_bn2hex(bn) : NULL;
    if (hex) snprintf(serial, sizeof serial, "%s", hex);
    OPENSSL_free(hex);
    BN_free(bn);
    X509_free(peer);
  }
  snprintf(info, sizeof info, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s", SSL_get_version(t->ssl), SSL_get_cipher_name(t->ssl), a, scn, icn, io, exp, sans, serial);
  return info;
}
