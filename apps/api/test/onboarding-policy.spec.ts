import { EmailService } from '../src/modules/email/email.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Request } from 'express';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service';
import { requireTransition } from '../src/modules/onboarding/transitions';
import { APPLICATION_STATUSES, ApplicationStatus } from '../src/modules/onboarding/entities';
import { clientBucket } from '../src/modules/onboarding/rate-limit';
import { allowedEndpoint } from '../../web/src/lib/bff-policy';
it('accepts only milestone 4 state transitions',()=>{
 expect(()=>requireTransition('INVITED','DRAFT')).not.toThrow();
 expect(()=>requireTransition('INVITED','SUBMITTED')).toThrow();
 expect(()=>requireTransition('SUBMITTED','CHANGES_REQUESTED')).not.toThrow();
 expect(()=>requireTransition('CHANGES_REQUESTED','RESUBMITTED')).not.toThrow();
 expect(()=>requireTransition('RESUBMITTED','APPROVED')).not.toThrow();
 expect(()=>requireTransition('APPROVED','CHANGES_REQUESTED')).toThrow();
 expect(()=>requireTransition('REJECTED','RESUBMITTED')).toThrow();
 expect(()=>requireTransition('DRAFT','SUBMITTED')).not.toThrow();
 expect(()=>requireTransition('SUBMITTED','DRAFT')).toThrow();
 expect(()=>requireTransition('DRAFT','APPROVED' as ApplicationStatus)).toThrow();
 // Outstanding corrections can be rejected, never approved without a resubmission.
 expect(()=>requireTransition('CHANGES_REQUESTED','REJECTED')).not.toThrow();
 expect(()=>requireTransition('CHANGES_REQUESTED','APPROVED')).toThrow();
 expect(()=>requireTransition('CHANGES_REQUESTED','CHANGES_REQUESTED')).toThrow();
});
it('keeps APPROVED and REJECTED terminal',()=>{
 for(const from of ['APPROVED','REJECTED'] as const)for(const to of APPLICATION_STATUSES)expect(()=>requireTransition(from,to)).toThrow();
});
it('buckets applicant rate limits by the BFF-forwarded client address',()=>{
 const req=(ip?:string)=>({headers:ip===undefined?{}:{'x-client-ip':ip}}) as unknown as Request;
 expect(clientBucket(req('203.0.113.7'))).toBe('203.0.113.7');
 expect(clientBucket(req('::ffff:203.0.113.7'))).toBe('203.0.113.7');
 // One IPv6 subscriber controls a /64, so addresses inside it share a bucket.
 expect(clientBucket(req('2001:db8:1:2:aaaa::1'))).toBe('2001:db8:1:2::/64');
 expect(clientBucket(req('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'))).toBe('2001:db8:1:2::/64');
 expect(clientBucket(req('2001:db8::1'))).toBe('2001:db8:0:0::/64');
 expect(clientBucket(req('not-an-ip'))).toBe('unknown');expect(clientBucket(req())).toBe('unknown');
});
it('fails closed for production verification before accessing the database',async()=>{
 const config=new ConfigService({NODE_ENV:'production'});
 const service=new OnboardingService({} as DataSource,config,new EmailService(config),{enabled:true} as StorageService,{} as never);
 await expect(service.begin({email:'fictional@example.test',token:'a'.repeat(64)},{} as Request)).rejects.toThrow('not configured');
 await expect(service.verify({challengeId:'unused',code:'12345678'},{} as Request)).rejects.toThrow('not configured');
});
it('keeps the applicant BFF limited to implemented routes',()=>{
 expect(allowedEndpoint('POST','applicant/verify')).toBe(true);
 expect(allowedEndpoint('PATCH','applicant/draft')).toBe(true);
 expect(allowedEndpoint('GET','applicant/codes')).toBe(false);
 expect(allowedEndpoint('POST','onboarding/applications/approve')).toBe(false);
 expect(allowedEndpoint('GET','applicant/../../users')).toBe(false);
 // The retired demo mailbox is no longer reachable through the BFF.
 expect(allowedEndpoint('GET','demo-mailbox')).toBe(false);
 expect(allowedEndpoint('POST','demo-mailbox/00000000-0000-0000-0000-000000000000/reveal')).toBe(false);
});
