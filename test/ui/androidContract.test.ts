const { readFileSync } = require('fs') as { readFileSync(path: string, encoding: string): string };
const { resolve } = require('path') as { resolve(...parts: string[]): string };

function read(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Android display contract', () => {
  it('locks MainActivity to portrait', () => {
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain(
      'android:screenOrientation="portrait"',
    );
  });

  it('registers a navigation-bar module that hides with transient swipe reveal', () => {
    const application = read('android/app/src/main/java/com/com.yunote.app/MainApplication.kt');
    const module = read('android/app/src/main/java/com/com.yunote.app/SystemBarsModule.kt');
    expect(application).toContain('add(SystemBarsPackage())');
    expect(module).toContain('hide(WindowInsets.Type.navigationBars())');
    expect(module).toContain('BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE');
  });
});

