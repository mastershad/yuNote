package com.yunote.app.security

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap

class YunoteInstallationKeysModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val keys = AndroidInstallationKeyStore()
  override fun getName() = "YunoteInstallationKeys"

  @ReactMethod
  fun ensureKey(alias: String, promise: Promise) {
    try {
      val result = WritableNativeMap()
      result.putString("publicKeyPem", keys.ensureKey(alias))
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("YUNOTE_KEY_UNAVAILABLE", "Installation key is unavailable", error)
    }
  }

  @ReactMethod
  fun signUtf8(alias: String, message: String, promise: Promise) {
    try {
      promise.resolve(keys.signUtf8(alias, message))
    } catch (error: Exception) {
      promise.reject("YUNOTE_SIGNING_FAILED", "Installation request could not be signed", error)
    }
  }

}
