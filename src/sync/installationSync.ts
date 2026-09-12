import type {OpSqliteDb} from '../db/connection';
import {createAndroidInstallationKeyProvider,type InstallationKeyProvider} from '../security/installationKeys';
import {createInstallationEnrollmentClient} from './installationEnrollment';
import {createJournalUploader} from './journalUploader';

export interface SecureLinkHandoff {
  pairingToken:string;
  pairingExpiresAt:string;
  cloudBaseUrl:string;
}

export interface InstallationSync {
  enrollAndFlush(input:SecureLinkHandoff):Promise<void>;
  flushIfEnrolled():Promise<boolean>;
}

interface StoredEndpointRow {status:string;cloud_base_url:string|null}

export function createInstallationSync(db:OpSqliteDb,keyProvider?:InstallationKeyProvider):InstallationSync {
  const keys=()=>keyProvider??createAndroidInstallationKeyProvider();
  const uploader=(baseUrl:string)=>createJournalUploader({db,keyProvider:keys(),baseUrl});
  return {
    async enrollAndFlush(input){
      if(!/^[0-9a-f]{64}$/i.test(input.pairingToken)||!Number.isFinite(Date.parse(input.pairingExpiresAt))||
        !/^https:\/\//i.test(input.cloudBaseUrl))throw new Error('Secure yuNote link handoff is malformed');
      const enrollment=createInstallationEnrollmentClient({db,keyProvider:keys(),baseUrl:input.cloudBaseUrl});
      await enrollment.enroll(input.pairingToken);
      await uploader(input.cloudBaseUrl).flush();
    },
    async flushIfEnrolled(){
      const row=(await db.execute('SELECT status,cloud_base_url FROM installation_identity WHERE singleton=1')).rows?.[0] as unknown as StoredEndpointRow|undefined;
      if(!row||row.status!=='enrolled'||typeof row.cloud_base_url!=='string')return false;
      await uploader(row.cloud_base_url).flush();
      return true;
    },
  };
}
