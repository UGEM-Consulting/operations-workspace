import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, existingCsv, parseCsv, readExistingFile, TEMPLATE } from './existing-csv.ts';

const heading = COLUMNS.map(([name]) => name).join(',');

describe('reading a CSV', () => {
  it('handles quotes, commas and line breaks inside fields, CRLF and a byte order mark', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  });
  it('skips blank lines', () => {
    assert.deepEqual(parseCsv('a,b\n\n,\n1,2'), [['a', 'b'], ['1', '2']]);
  });
});

describe('reading the file', () => {
  it('numbers rows as a spreadsheet does and leaves empty cells out', () => {
    const result = readExistingFile(`${heading}\nRiley,Santos,Dispatcher,Northwind,,Dispatcher,2024-03-04,,,,,,,\n`);
    assert.deepEqual(result.rows, [{ row: 2, firstName: 'Riley', lastName: 'Santos', position: 'Dispatcher', mc: 'Northwind', jobTitle: 'Dispatcher', startedOn: '2024-03-04' }]);
  });
  it('keeps the spreadsheet’s row numbers past blank rows and line breaks inside a cell', () => {
    const result = readExistingFile(`${heading}\nRiley,Santos\n\n,,,\n"Sky\nLee",Martin\nJo,Park\n`);
    assert.deepEqual(result.rows?.map(row => [row.row, row.lastName]), [[2, 'Santos'], [5, 'Martin'], [6, 'Park']]);
  });
  it('finds the columns in any order and spelling', () => {
    const result = readExistingFile(`Last Name,FIRST-NAME,${COLUMNS.slice(2).map(([name]) => name).join(',')}\nSantos,Riley\n`);
    assert.equal(result.rows?.[0].firstName, 'Riley');
    assert.equal(result.rows?.[0].lastName, 'Santos');
  });
  it('reads the load board account each sign-in is on, and works without those columns', () => {
    const named = readExistingFile('first_name,last_name,position,mc,team,job_title,started_on,company_email,ringcentral_number,personal_email,personal_phone,supports,nda_signed_on,sop_signed_on,dat_email,dat_account\nRiley,Santos,Dispatcher,Northwind,,Dispatcher,,,,,,,,,ryan@example.test,YouPro DAT\n');
    assert.equal(named.error, undefined);
    assert.deepEqual([named.rows[0].datEmail, named.rows[0].datAccount], ['ryan@example.test', 'YouPro DAT']);
    const older = readExistingFile('first_name,last_name,position,mc,team,job_title,started_on,company_email,ringcentral_number,personal_email,personal_phone,supports,nda_signed_on,sop_signed_on\nRiley,Santos,Dispatcher,Northwind,,Dispatcher,,,,,,,,\n');
    assert.equal(older.error, undefined);
  });
  it('says what is wrong with an unusable file', () => {
    assert.match(readExistingFile('').error ?? '', /empty/);
    assert.match(readExistingFile('first_name,last_name\nA,B').error ?? '', /missing these columns: position/);
    assert.match(readExistingFile(heading).error ?? '', /no people/);
    assert.match(readExistingFile([heading, ...Array(501).fill('A,B')].join('\n')).error ?? '', /501 rows/);
  });
  it('reads back its own template', () => {
    const rows = readExistingFile(TEMPLATE).rows ?? [];
    assert.equal(rows.length, 4);
    assert.equal(rows[1].supports, 'Riley Santos');
    assert.equal(rows[2].team, 'Avery team');
    assert.equal(rows[0].ndaSignedOn, '2024-03-04');
    // Someone who left, with their last day, reason and legal name (section 33), and another name separated by ;.
    assert.deepEqual([rows[3].status, rows[3].leftOn, rows[3].leftReason, rows[3].legalFirstName], ['Left', '2025-08-15', 'Moved to another company.', 'Andrew']);
    assert.equal(rows[2].otherNames, 'Alex Moore');
    assert.ok(rows.every(row => !row.personalEmail || row.personalEmail.endsWith('@example.test')));
  });
});

describe('writing rows back', () => {
  it('quotes what needs it and stops spreadsheets running formulas, keeping phones as they are', () => {
    const text = existingCsv([{ row: 2, firstName: '=SUM(A1)', lastName: 'O"Brien, Jr', personalPhone: '+1 202 555 0147' }]);
    const row = readExistingFile(text).rows?.[0];
    assert.equal(row?.firstName, "'=SUM(A1)");
    assert.equal(row?.lastName, 'O"Brien, Jr');
    assert.equal(row?.personalPhone, '+1 202 555 0147');
  });
});
