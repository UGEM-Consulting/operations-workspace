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
  it('says what is wrong with an unusable file', () => {
    assert.match(readExistingFile('').error ?? '', /empty/);
    assert.match(readExistingFile('first_name,last_name\nA,B').error ?? '', /missing these columns: position/);
    assert.match(readExistingFile(heading).error ?? '', /no people/);
    assert.match(readExistingFile([heading, ...Array(501).fill('A,B')].join('\n')).error ?? '', /501 rows/);
  });
  it('reads back its own template', () => {
    const rows = readExistingFile(TEMPLATE).rows ?? [];
    assert.equal(rows.length, 2);
    assert.equal(rows[1].supports, 'Riley Santos');
    assert.equal(rows[0].ndaSignedOn, '2024-03-04');
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
