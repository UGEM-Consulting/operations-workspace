import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeNavigationItem, breadcrumbTrail, navigationSections } from './navigation.ts';

const items = [
  { key: 'dashboard', href: '/dashboard', label: 'Overview', section: null },
  { key: 'onboarding', href: '/onboarding', label: 'Dispatcher onboarding', section: 'Onboarding' },
  { key: 'applications', href: '/onboarding/applications', label: 'Applications', section: 'Onboarding' },
  { key: 'it', href: '/it/tasks', label: 'IT tasks', section: 'IT' },
  { key: 'security', href: '/account/security', label: 'Account security', section: 'Account' },
];

describe('workspace navigation', () => {
  it('highlights the most specific destination, including record pages below it', () => {
    assert.equal(activeNavigationItem(items, '/onboarding/applications/abc')?.key, 'applications');
    assert.equal(activeNavigationItem(items, '/onboarding-other'), undefined);
  });
  it('builds breadcrumbs from the containing destinations, with only the current page unlinked', () => {
    assert.deepEqual(breadcrumbTrail(items, '/onboarding/applications'), [{ label: 'Dispatcher onboarding', href: '/onboarding' }, { label: 'Applications' }]);
    assert.deepEqual(breadcrumbTrail(items, '/onboarding/applications/abc', 'Jordan Fictional'),
      [{ label: 'Dispatcher onboarding', href: '/onboarding' }, { label: 'Applications', href: '/onboarding/applications' }, { label: 'Jordan Fictional' }]);
    assert.deepEqual(breadcrumbTrail(items, '/it/tasks/abc'), [{ label: 'IT tasks', href: '/it/tasks' }, { label: 'Details' }]);
    assert.deepEqual(breadcrumbTrail(items, '/access-denied'), []);
  });
  it('groups the sidebar by section in server order and leaves account items to the account menu', () => {
    assert.deepEqual(navigationSections(items).map(section => [section.label, section.items.map(item => item.key)]),
      [[null, ['dashboard']], ['Onboarding', ['onboarding', 'applications']], ['IT', ['it']]]);
  });
});
