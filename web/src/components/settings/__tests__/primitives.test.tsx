/**
 * Smoke tests for the Settings primitives.
 *
 * These cover the surface a contributor is most likely to break by
 * accident: button click semantics, controlled-toggle state, radio
 * selection, the error-message helper's edge cases.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  Button,
  ErrorBox,
  Hint,
  ModeRadio,
  SectionLoading,
  Toggle,
  saveErrorMessage,
} from '../primitives';

// ── Button ─────────────────────────────────────────────────────────

describe('Button', () => {
  it('renders its children and fires onClick when enabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Apply</Button>);
    const btn = screen.getByRole('button', { name: 'Apply' });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Apply
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

// ── Toggle ─────────────────────────────────────────────────────────

describe('Toggle', () => {
  it('reports its checked state via aria-checked', () => {
    render(<Toggle checked={true} onChange={() => {}} />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('flips state when clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('ignores clicks when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} disabled />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── ModeRadio ──────────────────────────────────────────────────────

describe('ModeRadio', () => {
  it('renders its label and blurb', () => {
    render(
      <ModeRadio
        checked={false}
        onSelect={() => {}}
        name="Direct AI service"
        blurb="Use your own AI service for the best quality."
      />,
    );
    expect(screen.getByText('Direct AI service')).toBeInTheDocument();
    expect(
      screen.getByText('Use your own AI service for the best quality.'),
    ).toBeInTheDocument();
  });

  it('marks the input checked when `checked` is true', () => {
    render(
      <ModeRadio
        checked={true}
        onSelect={() => {}}
        name="Direct AI service"
        blurb="..."
      />,
    );
    expect(screen.getByRole('radio')).toBeChecked();
  });

  it('fires onSelect on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModeRadio
        checked={false}
        onSelect={onSelect}
        name="Local model"
        blurb="No API key, no network."
      />,
    );
    await user.click(screen.getByRole('radio'));
    expect(onSelect).toHaveBeenCalled();
  });
});

// ── ErrorBox / Hint / SectionLoading ───────────────────────────────

describe('ErrorBox', () => {
  it('shows the message and a friendly preamble', () => {
    render(<ErrorBox message="network down" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load config.');
    expect(screen.getByRole('alert')).toHaveTextContent('network down');
  });
});

describe('Hint', () => {
  it('renders its children', () => {
    render(<Hint tone="good">all clear</Hint>);
    expect(screen.getByText('all clear')).toBeInTheDocument();
  });
});

describe('SectionLoading', () => {
  it('renders the live-region label', () => {
    render(<SectionLoading rows={2} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading current settings…');
  });
});

// ── saveErrorMessage ───────────────────────────────────────────────

describe('saveErrorMessage', () => {
  it('includes the human-readable status and a non-empty fallback', async () => {
    const res = new Response('', { status: 500, statusText: 'Internal Server Error' });
    const msg = await saveErrorMessage('Avatar save failed', res);
    expect(msg).toContain('Avatar save failed');
    expect(msg).toContain('HTTP 500');
    expect(msg).toContain('Internal Server Error');
    expect(msg).toContain('Server returned no message.');
  });

  it('includes the body when the server returned one', async () => {
    const res = new Response('config key `tts_speed` was nan', { status: 400 });
    const msg = await saveErrorMessage('Avatar save failed', res);
    expect(msg).toContain('HTTP 400');
    expect(msg).toContain('config key `tts_speed` was nan');
  });

  it('truncates very long bodies', async () => {
    const big = 'x'.repeat(1000);
    const res = new Response(big, { status: 500 });
    const msg = await saveErrorMessage('Avatar save failed', res);
    expect(msg.length).toBeLessThan(400);
    expect(msg).toContain('(truncated)');
  });
});
