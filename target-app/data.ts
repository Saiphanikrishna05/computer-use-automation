/**
 * Fixture data for the stand-in servicing console.
 *
 * Every value here is invented. The SSNs and dates of birth are format-valid
 * but fictitious, and they exist for exactly one reason: to give the redaction
 * layer and the screenshot masker something real to catch. A demo where no
 * sensitive data ever appears on screen does not prove that sensitive data is
 * being handled.
 */

export interface Member {
  id: string;
  name: string;
  ssn: string;
  dateOfBirth: string;
  email: string;
  phone: string;
  memberSince: string;
  status: 'Active' | 'Dormant';
  accounts: Array<{ type: string; number: string; balance: number; opened: string }>;
  /** Staff at this tenant are not entitled to view this member. */
  restricted?: boolean;
  /** Loading the detail view raises an unexpected system notice. */
  raisesNotice?: boolean;
}

export const MEMBERS: Record<string, Member> = {
  '100001': {
    id: '100001',
    name: 'Dolores Ashcroft',
    ssn: '412-88-1097',
    dateOfBirth: '03/14/1968',
    email: 'd.ashcroft@example.invalid',
    phone: '503-555-0142',
    memberSince: '11/02/1994',
    status: 'Active',
    accounts: [
      { type: 'Savings', number: '000410028815', balance: 4182.55, opened: '11/02/1994' },
      { type: 'Checking', number: '000410028816', balance: 918.2, opened: '01/17/1996' },
      { type: 'Certificate', number: '000410028817', balance: 10000.0, opened: '06/30/2019' },
    ],
  },
  '100002': {
    id: '100002',
    name: 'Marcus Feld',
    ssn: '287-44-6610',
    dateOfBirth: '09/22/1981',
    email: 'm.feld@example.invalid',
    phone: '503-555-0198',
    memberSince: '04/19/2008',
    status: 'Active',
    accounts: [{ type: 'Savings', number: '000410031002', balance: 2050.0, opened: '04/19/2008' }],
    restricted: true,
  },
  '100003': {
    id: '100003',
    name: 'Yvonne Petrakis',
    ssn: '551-09-3374',
    dateOfBirth: '12/05/1975',
    email: 'y.petrakis@example.invalid',
    phone: '971-555-0117',
    memberSince: '08/08/2013',
    status: 'Dormant',
    accounts: [
      { type: 'Savings', number: '000410044190', balance: 220.1, opened: '08/08/2013' },
      { type: 'Checking', number: '000410044191', balance: 55.0, opened: '08/08/2013' },
    ],
    raisesNotice: true,
  },
  '100004': {
    id: '100004',
    name: 'Aaron Kwan',
    ssn: '330-71-2245',
    dateOfBirth: '07/30/1990',
    email: 'a.kwan@example.invalid',
    phone: '360-555-0164',
    memberSince: '02/14/2016',
    status: 'Active',
    accounts: [
      { type: 'Savings', number: '000410052871', balance: 15300.0, opened: '02/14/2016' },
      { type: 'Checking', number: '000410052872', balance: 2210.75, opened: '02/14/2016' },
    ],
  },
};

export const OPERATOR_CREDENTIALS = {
  username: 'teller01',
  password: 'demo-password',
};

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
