package com.yunote.app.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class AndroidInstallationKeyStore {
  @Synchronized
  fun ensureKey(alias: String): String {
    validateAlias(alias)
    val store = keyStore()
    if (!store.containsAlias(alias)) generate(alias)
    val certificate = keyStore().getCertificate(alias)
      ?: throw IllegalStateException("Installation key certificate is missing")
    if (certificate.publicKey.algorithm != KeyProperties.KEY_ALGORITHM_EC) {
      throw IllegalStateException("Installation key has an unexpected algorithm")
    }
    return toPem(certificate.publicKey.encoded)
  }

  @Synchronized
  fun signUtf8(alias: String, message: String): String {
    validateAlias(alias)
    val entry = keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
      ?: throw IllegalStateException("Installation key is missing")
    val signature = Signature.getInstance("SHA256withECDSA").run {
      initSign(entry.privateKey)
      update(message.toByteArray(StandardCharsets.UTF_8))
      sign()
    }
    return Base64.encodeToString(signature, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  }

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun generate(alias: String) {
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      // Background sync must continue while the device is locked.
      .setUserAuthenticationRequired(false)
      .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
      initialize(spec)
      generateKeyPair()
    }
  }

  private fun validateAlias(alias: String) {
    require(Regex("^[A-Za-z0-9._-]{1,120}$").matches(alias)) { "Installation key alias is invalid" }
  }

  private fun toPem(encoded: ByteArray): String {
    val base64 = Base64.encodeToString(encoded, Base64.NO_WRAP)
    return "-----BEGIN PUBLIC KEY-----\n" + base64.chunked(64).joinToString("\n") + "\n-----END PUBLIC KEY-----\n"
  }
}
