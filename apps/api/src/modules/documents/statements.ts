import { DOCUMENT_RULES, type CompanyDocument } from './documents.entity';
// The exact wording shown to the signer is stored with every signature, so changing these texts never alters past
// evidence. The English text governs; the Russian translation is displayed for convenience.
export const ESIGN_CONSENT = 'I agree to receive, review and sign these onboarding documents electronically. I understand that my electronic signature has the same legal effect as a handwritten signature, that I may ask my manager for a paper copy instead, and that I can download a signed copy after signing.';
export const ESIGN_CONSENT_RU = 'Я согласен(на) получать, просматривать и подписывать эти документы в электронном виде. Я понимаю, что моя электронная подпись имеет ту же юридическую силу, что и собственноручная, что я могу попросить у менеджера бумажный экземпляр и что после подписания я могу скачать подписанную копию.';
type Doc = Pick<CompanyDocument,'kind'|'title'|'version'>;
export function applicantStatement(doc: Doc): { statement: string; translatedStatement: string } {
 const name = `${doc.title} (version ${doc.version})`, ru = `«${doc.title}» (версия ${doc.version})`;
 if (!DOCUMENT_RULES[doc.kind].signature) return {
  statement: `I have opened and read the ${name} and will use it as directed.`,
  translatedStatement: `Я открыл(а) и прочитал(а) документ ${ru} и буду использовать его по назначению.`,
 };
 const intent = 'I intend my typed name and drawn signature to be my legally binding electronic signature.';
 const intentRu = 'Я подтверждаю, что введённое мной имя и нарисованная подпись являются моей юридически обязывающей электронной подписью.';
 return doc.kind === 'SOP' ? {
  statement: `I have read the entire ${name}, I understand it and I agree to follow it. ${intent}`,
  translatedStatement: `Я полностью прочитал(а) документ ${ru}, понимаю его и обязуюсь его соблюдать. ${intentRu}`,
 } : {
  statement: `I have read the entire ${name} and I agree to be bound by its terms. ${intent}`,
  translatedStatement: `Я полностью прочитал(а) документ ${ru} и соглашаюсь соблюдать его условия. ${intentRu}`,
 };
}
export function companyStatement(doc: Doc, applicantName: string): string {
 return `On behalf of the company, I countersign the ${doc.title} (version ${doc.version}) signed by ${applicantName}. I am authorized to sign it, and I intend my typed name and drawn signature to be my legally binding electronic signature.`;
}
