import type {OpSqliteDb} from '../db/connection';
import {createAndroidInstallationKeyProvider,type InstallationKeyProvider} from '../security/installationKeys';
import {createInstallationEnrollmentClient} from './installationEnrollment';
import {createJournalUploader} from './journalUploader';
import {createCollaborationInbox} from './collaborationInbox';
import {createCollaborationOutbox} from './collaborationOutbox';

export interface SecureLinkHandoff {
  pairingToken:string;
  pairingExpiresAt:string;
  cloudBaseUrl:string;
}

export interface InstallationSync {
  enrollAndFlush(input:SecureLinkHandoff):Promise<void>;
  flushIfEnrolled():Promise<boolean>;
  unlink():Promise<void>;
}

interface StoredEndpointRow {status:string;cloud_base_url:string|null}

export function createInstallationSync(db:OpSqliteDb,keyProvider?:InstallationKeyProvider):InstallationSync {
  const keys=()=>keyProvider??createAndroidInstallationKeyProvider();
  const uploaders=new Map<string,ReturnType<typeof createJournalUploader>>();
  const inboxes=new Map<string,ReturnType<typeof createCollaborationInbox>>();
  const collaborationOutboxes=new Map<string,ReturnType<typeof createCollaborationOutbox>>();
  const uploader=(baseUrl:string)=>{
    let existing=uploaders.get(baseUrl);
    if(!existing){existing=createJournalUploader({db,keyProvider:keys(),baseUrl});uploaders.set(baseUrl,existing);}
    return existing;
  };
  const inbox=(baseUrl:string)=>{
    let existing=inboxes.get(baseUrl);
    if(!existing){existing=createCollaborationInbox({db,keyProvider:keys(),baseUrl});inboxes.set(baseUrl,existing);}
    return existing;
  };
  const collaborationOutbox=(baseUrl:string)=>{
    let existing=collaborationOutboxes.get(baseUrl);
    if(!existing){existing=createCollaborationOutbox({db,keyProvider:keys(),baseUrl});collaborationOutboxes.set(baseUrl,existing);}
    return existing;
  };
  let running:Promise<void>|undefined;
  let rerun=false;
  const schedule=async(baseUrl:string):Promise<void>=>{
    rerun=true;
    if(!running){
      running=(async()=>{
        do{
          rerun=false;
          let outcome=await uploader(baseUrl).flush();
          while(outcome.status==='uploaded')outcome=await uploader(baseUrl).flush();
          let outgoing=await collaborationOutbox(baseUrl).flush();
          while(outgoing.status==='uploaded'||outgoing.status==='discarded')outgoing=await collaborationOutbox(baseUrl).flush();
          let collaboration=await inbox(baseUrl).pollApplyAndAcknowledge();
          while(collaboration.status==='applied')collaboration=await inbox(baseUrl).pollApplyAndAcknowledge();
          if(outgoing.status==='conflict')rerun=true;
        }while(rerun);
      })().finally(()=>{running=undefined;});
    }
    await running;
  };
  return {
    async enrollAndFlush(input){
      if(!/^[0-9a-f]{64}$/i.test(input.pairingToken)||!Number.isFinite(Date.parse(input.pairingExpiresAt))||
        !/^https:\/\//i.test(input.cloudBaseUrl))throw new Error('Secure yuNote link handoff is malformed');
      const enrollment=createInstallationEnrollmentClient({db,keyProvider:keys(),baseUrl:input.cloudBaseUrl});
      await enrollment.enroll(input.pairingToken);
      await schedule(input.cloudBaseUrl);
    },
    async flushIfEnrolled(){
      const row=(await db.execute('SELECT status,cloud_base_url FROM installation_identity WHERE singleton=1')).rows?.[0] as unknown as StoredEndpointRow|undefined;
      if(!row||row.status!=='enrolled'||typeof row.cloud_base_url!=='string')return false;
      await schedule(row.cloud_base_url);
      return true;
    },
    async unlink(){
      const row=(await db.execute('SELECT key_alias FROM installation_identity WHERE singleton=1')).rows?.[0] as {key_alias:string}|undefined;
      await db.execute('DELETE FROM installation_identity WHERE singleton=1');
      if(row){
        try{await keys().deleteKey?.(row.key_alias);}catch{/* Server revocation and deleted metadata already removed authority. */}
      }
    },
  };
}
