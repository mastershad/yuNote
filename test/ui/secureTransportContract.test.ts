const { readFileSync } = require('fs') as { readFileSync(path: string, encoding: string): string };
const { resolve } = require('path') as { resolve(...parts: string[]): string };
const read = (path: string) => readFileSync(resolve(__dirname, '..', '..', path), 'utf8');
export {};

describe('secure background transport contract', () => {
  it('protects the exported bound service with a signature permission', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:name="com.yunote.permission.LOCAL_TRANSPORT"');
    expect(manifest).toContain('android:protectionLevel="signature"');
    expect(manifest).toContain('android:name=".transport.YunoteTransportService"');
    expect(manifest).toContain('android:exported="true"');
    expect(manifest).toContain('android:permission="com.yunote.permission.LOCAL_TRANSPORT"');
    expect(manifest).toContain('<package android:name="com.iotkeyfobplatform.app" />');
  });

  it('runs messages as a headless JS task while the UI is closed', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const service = read('android/app/src/main/java/com/com.yunote.app/transport/YunoteTransportService.kt');
    const index = read('index.js');
    expect(manifest).toContain('<uses-permission android:name="android.permission.WAKE_LOCK" />');
    expect(service).toContain('Messenger(IncomingHandler())');
    expect(service).toContain('override fun onBind');
    expect(service).toContain('startTask(');
    expect(service).toContain('HeadlessJsTaskConfig(');
    expect(index).toContain("registerHeadlessTask('YunoteTransportTask'");
  });
});
