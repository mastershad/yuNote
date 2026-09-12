import {NativeModules} from 'react-native';

export interface InstallationKeyProvider {
  ensureKey(alias:string):Promise<{publicKeyPem:string}>;
  signUtf8(alias:string,message:string):Promise<string>;
  sha256Utf8(value:string):Promise<string>;
}

interface NativeInstallationKeys {
  ensureKey(alias:string):Promise<{publicKeyPem:string}>;
  signUtf8(alias:string,message:string):Promise<string>;
  sha256Utf8(value:string):Promise<string>;
}

export function createAndroidInstallationKeyProvider(native:NativeInstallationKeys=NativeModules.YunoteInstallationKeys):InstallationKeyProvider {
  if(!native)throw new Error('YunoteInstallationKeys native module is unavailable');
  return {
    ensureKey:alias=>native.ensureKey(alias),
    signUtf8:(alias,message)=>native.signUtf8(alias,message),
    sha256Utf8:value=>native.sha256Utf8(value),
  };
}

export function createInMemoryInstallationKeyProvider(options:{create:(alias:string)=>{publicKeyPem:string;sign:(message:string)=>string|Promise<string>}}):InstallationKeyProvider {
  const keys=new Map<string,{publicKeyPem:string;sign:(message:string)=>string|Promise<string>}>();
  return {
    async ensureKey(alias){
      let key=keys.get(alias);
      if(!key){key=options.create(alias);keys.set(alias,key);}
      return {publicKeyPem:key.publicKeyPem};
    },
    async signUtf8(alias,message){
      const key=keys.get(alias);
      if(!key)throw new Error(`Installation key is missing: ${alias}`);
      return key.sign(message);
    },
    async sha256Utf8(){
      throw new Error('No SHA-256 implementation was supplied for the in-memory key provider');
    },
  };
}
