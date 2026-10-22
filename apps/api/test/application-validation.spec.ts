import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DraftDto } from '../src/modules/onboarding/dto';
import { INTERNATIONAL_PHONE_PATTERN, requiredApplicantFields } from '../src/modules/onboarding/application-requirements';
import { createFormControl } from 'react-hook-form';
import { applicationDraftResolver, applicationValidationFeedback, applicationSubmitSchema } from '../../web/src/features/onboarding/application-schema';
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

it('reports a hidden invalid phone through the real form resolver and accepts submission after correction',async()=>{
 const form=createFormControl({resolver:applicationDraftResolver,defaultValues:{...valid,workPhoneNumber:'123'}});
 const send=jest.fn();
 let feedback: ReturnType<typeof applicationValidationFeedback> | undefined;
 await form.handleSubmit(send, errors=>{feedback=applicationValidationFeedback(Object.entries(errors).map(([field,error])=>({path:[field],message:String(error?.message)})));})();
 expect(send).not.toHaveBeenCalled();
 expect(feedback).toMatchObject({step:0,field:'workPhoneNumber'});
 expect(feedback?.message).toContain('7–15 digits');
 form.setValue('workPhoneNumber','+44 20 7946 0958');
 await form.handleSubmit(send)();
 expect(send).toHaveBeenCalledTimes(1);
 expect(send.mock.calls[0][0]).toMatchObject(valid);
});
it('directs hidden employment resolver errors back to the employment step',async()=>{
 const form=createFormControl({resolver:applicationDraftResolver,defaultValues:{...valid,mcName:'x'.repeat(151)}});
 const send=jest.fn();
 let step: number | undefined;
 await form.handleSubmit(send,errors=>{step=applicationValidationFeedback(Object.entries(errors).map(([field,error])=>({path:[field],message:String(error?.message)}))).step;})();
 expect(send).not.toHaveBeenCalled();expect(step).toBe(1);
});
it('keeps missing accuracy confirmation on review and prioritizes personal errors when several steps need corrections',()=>{
 const accuracy=applicationSubmitSchema(false).safeParse({...valid,accurate:false});
 expect(accuracy.success).toBe(false);
 if(!accuracy.success)expect(applicationValidationFeedback(accuracy.error.issues)).toMatchObject({step:3,field:'accurate'});
 const multiple=applicationSubmitSchema(false).safeParse({...valid,firstName:'',mcName:'',accurate:false});
 expect(multiple.success).toBe(false);
 if(!multiple.success)expect(applicationValidationFeedback(multiple.error.issues)).toMatchObject({step:0,field:'firstName'});
});
