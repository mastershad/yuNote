import {createInMemoryInstallationKeyProvider} from '../../src/security/installationKeys';

describe('installation key provider',()=>{
  it('keeps one non-exportable logical key per alias and signs through the provider',async()=>{
    const provider=createInMemoryInstallationKeyProvider({
      create:alias=>({publicKeyPem:`public:${alias}`,sign:message=>`signature:${message}`}),
    });
    await expect(provider.ensureKey('yunote-installation-1')).resolves.toEqual({publicKeyPem:'public:yunote-installation-1'});
    await expect(provider.ensureKey('yunote-installation-1')).resolves.toEqual({publicKeyPem:'public:yunote-installation-1'});
    await expect(provider.signUtf8('yunote-installation-1','canonical')).resolves.toBe('signature:canonical');
    expect('exportPrivateKey' in provider).toBe(false);
  });

  it('does not sign with an unknown alias',async()=>{
    const provider=createInMemoryInstallationKeyProvider({create:()=>({publicKeyPem:'public',sign:()=> 'signature'})});
    await expect(provider.signUtf8('missing','canonical')).rejects.toThrow(/missing/);
  });
});
