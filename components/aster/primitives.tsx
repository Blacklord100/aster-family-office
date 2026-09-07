'use client';
import type { ReactNode } from 'react';
import { ArrowUpRight, Info, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
export const money = (n: number, digits = 1) =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'EUR',
    notation: Math.abs(n) >= 1e6 ? 'compact' : 'standard',
    minimumFractionDigits: Math.abs(n) >= 1e6 ? digits : 0,
    maximumFractionDigits: Math.abs(n) >= 1e6 ? digits : 0,
  })
    .format(n)
    .replace('m', 'M');
export const percent = (n: number, digits = 1) =>
  (n * 100).toFixed(digits) + '%';
export const dateLabel = (s: string) =>
  new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
export function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      items={options}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function FamilyPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <Picker
      label="Family scope"
      value={value}
      onChange={onChange}
      options={[
        { value: 'all', label: 'All families' },
        { value: 'laurent', label: 'Laurent family' },
        { value: 'bergstrom', label: 'Bergström family' },
        { value: 'chen', label: 'Chen family' },
      ]}
    />
  );
}
export function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function ViewTabs({
  value,
  onChange,
  items,
  compact = false,
}: {
  value: string;
  onChange: (s: string) => void;
  items: string[];
  compact?: boolean;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange(String(v))}
      className={compact ? 'compact-tabs' : 'view-tabs'}
    >
      <TabsList variant={compact ? 'default' : 'line'}>
        {items.map((i) => (
          <TabsTrigger key={i} value={i.toLowerCase()}>
            {i}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
export function Metric({
  label,
  value,
  note,
  positive = false,
  help,
}: {
  label: string;
  value: string;
  note: string;
  positive?: boolean;
  help?: string;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {help ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button aria-label={'About ' + label} className="info-button" />
              }
            >
              <Info />
            </TooltipTrigger>
            <TooltipContent className="metric-tooltip">{help}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="metric-value">{value}</div>
      <div className={positive ? 'metric-note positive' : 'metric-note'}>
        {positive ? <ArrowUpRight /> : null}
        {note}
      </div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'panel ' + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Monogram({
  name,
  color = 'violet',
}: {
  name: string;
  color?: string;
}) {
  return <span className={'investment-monogram ' + color}>{name[0]}</span>;
}
export function Status({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <Badge variant="secondary" className={'status-badge ' + tone}>
      {children}
    </Badge>
  );
}
export function TextAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button variant="link" onClick={onClick}>
      {children}
      <ChevronRight data-icon="inline-end" />
    </Button>
  );
}
