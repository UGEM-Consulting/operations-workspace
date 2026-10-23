import { EmailService } from '../src/modules/email/email.service';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Request } from 'express';
import { OnboardingService } from '../src/modules/onboarding/onboarding.service';
import { requireTransition } from '../src/modules/onboarding/transitions';
import { ApplicationStatus } from '../src/modules/onboarding/entities';
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
});
it('fails closed for production verification before accessing the database',async()=>{
 const config=new ConfigService({NODE_ENV:'production'});
 const service=new OnboardingService({} as DataSource,config,new EmailService(config));
 await expect(service.begin({email:'fictional@example.test',token:'a'.repeat(64)})).rejects.toThrow('not configured');
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
