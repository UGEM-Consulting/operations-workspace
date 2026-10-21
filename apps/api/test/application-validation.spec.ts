import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DraftDto } from '../src/modules/onboarding/dto';
import { INTERNATIONAL_PHONE_PATTERN, requiredApplicantFields } from '../src/modules/onboarding/application-requirements';
import { applicationSubmitSchema } from '../../web/src/features/onboarding/application-schema';
const valid={firstName:'Fictional',lastName:'Applicant',personalPhoneNumber:'+1 202 555 0123',workPhoneNumber:'+44 20 7946 0958',preferredAmericanFirstName:'Alex',preferredAmericanLastName:'Demo',telegram:'',mcName:'Independent',teamLead:'Independent',jobTitle:'Dispatcher',accurate:true};
it.each(['+996 (555) 123-456','+44 20 7946 0958','(202) 555-0123','+33.1.23.45.67.89'])('accepts international formatting consistently: %s',async number=>{
 expect(INTERNATIONAL_PHONE_PATTERN.test(number)).toBe(true);
 expect(applicationSubmitSchema(false).safeParse({...valid,personalPhoneNumber:number,workPhoneNumber:number}).success).toBe(true);
 expect(await validate(plainToInstance(DraftDto,{version:0,personalPhoneNumber:number,workPhoneNumber:number}))).toHaveLength(0);
});
it.each(['workPhoneNumber','preferredAmericanFirstName','preferredAmericanLastName'])('requires nonblank %s in the frontend and backend merged-field validation',field=>{
 expect(applicationSubmitSchema(false).safeParse({...valid,[field]:'   '}).success).toBe(false);
 expect(requiredApplicantFields({...valid,[field]:'   '})).toContain(field);
});
it.each(['123','letters','++1 202 555 0123','+1234567890123456'])('rejects invalid phones consistently: %s',async number=>{
 expect(applicationSubmitSchema(false).safeParse({...valid,workPhoneNumber:number}).success).toBe(false);
 expect(requiredApplicantFields({...valid,workPhoneNumber:number})).toContain('workPhoneNumber');
 expect((await validate(plainToInstance(DraftDto,{version:0,workPhoneNumber:number}))).length).toBeGreaterThan(0);
});
it('trims American names without replacing the retained legal name',()=>{
 const parsed=applicationSubmitSchema(false).parse({...valid,preferredAmericanFirstName:' Alex ',preferredAmericanLastName:' Demo '});
 expect(parsed.preferredAmericanFirstName).toBe('Alex');expect(parsed.preferredAmericanLastName).toBe('Demo');expect(parsed.firstName).toBe('Fictional');
});
