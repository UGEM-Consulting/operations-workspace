import { PDFDocument, StandardFonts } from 'pdf-lib';
import { checkedFields, fillFields, type DocumentField } from '../src/modules/documents/fields';

describe('document fields', () => {
  const box: DocumentField = { page: 1, x: 0.1, y: 0.1, width: 0.1, height: 0.02, kind: 'ADDRESS', signer: 'SIGNER' };

  it('cuts text that doesn’t fit its box short, so it never prints past it', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const drawn: { text: string; size: number }[] = [];
    const draw = page.drawText.bind(page);
    page.drawText = (text, options) => { drawn.push({ text, size: options!.size! }); draw(text, options); };
    const address = '12345 A Very Long Fictional Boulevard Name, Apartment 9876, Springfield Heights, TX 73301';
    expect(await fillFields(pdf, [box], [{ signerRole: 'APPLICANT', typedName: 'Fictional Driver', signedAt: new Date(), address, signatureImage: null }])).toBe(1);
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].text.endsWith('...')).toBe(true);
    expect(font.widthOfTextAtSize(drawn[0].text, drawn[0].size)).toBeLessThanOrEqual(box.width * 612);
  });

  it('limits a document to the field kinds it allows', () => {
    const rules = { signature: false, typedName: true, countersign: false, americanName: false, address: true, kinds: ['NAME', 'ADDRESS', 'DATE'] as const };
    expect(checkedFields([box], 1, rules)).toEqual([box]);
    expect(() => checkedFields([{ ...box, kind: 'DAY' }], 1, rules)).toThrow('This document can’t take that field.');
    expect(() => checkedFields([box], 1, { ...rules, address: false, kinds: undefined })).toThrow('Only a notice letter has an address field.');
  });
});
