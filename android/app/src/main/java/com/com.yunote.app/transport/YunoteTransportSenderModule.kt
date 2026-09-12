package com.yunote.app.transport

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class YunoteTransportSenderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "YunoteTransportSender"

  @ReactMethod
  fun sendMessage(uri: String, extras: ReadableMap, promise: Promise) {
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
        setPackage("com.iotkeyfobplatform.app")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra("transferId", extras.getString("transferId"))
        putExtra("kind", extras.getString("kind"))
        putExtra("payloadJson", extras.getString("payloadJson"))
      }
      if (intent.resolveActivity(reactContext.packageManager) == null) {
        throw ActivityNotFoundException("Key Fob transport receiver is unavailable")
      }
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SEND_FAILED", error.message, error)
    }
  }
}

