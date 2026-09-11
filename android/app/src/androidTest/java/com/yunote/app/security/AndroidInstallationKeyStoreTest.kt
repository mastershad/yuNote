package com.yunote.app.security

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidInstallationKeyStoreTest {
  @Test
  fun createsStableP256IdentityAndProducesVerifiableSignature() {
    val alias = "yunote-instrumentation-${System.currentTimeMillis()}"
    val keys = AndroidInstallationKeyStore()
    val firstPem = keys.ensureKey(alias)
    assertEquals(firstPem, keys.ensureKey(alias))

    val publicDer = Base64.decode(firstPem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace("\n", ""), Base64.DEFAULT)
    val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicDer))
    val signature = Base64.decode(keys.signUtf8(alias, "yunote-keystore-probe"), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    val valid = Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update("yunote-keystore-probe".toByteArray(Charsets.UTF_8))
      verify(signature)
    }
    assertTrue(valid)
  }
}
