'use client';

import type { ReactNode, CSSProperties } from 'react';
import {
  Asterisk,
  House,
  BriefcaseBusiness,
  Clock3,
  Mail,
  ChartNoAxesCombined,
  Bot,
  Link2,
  Search,
  Sparkles,
  ChevronDown,
  Settings2,
  PanelLeft,
  ArrowUpRight,
} from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useWorkspace } from './workspace-context';

export type View =
  | 'overview'
  | 'investments'
  | 'timeline'
  | 'inbox'
  | 'reports'
  | 'agents'
  | 'connections';
export const navigation = [
  { id: 'overview', label: 'Overview', icon: House },
  { id: 'investments', label: 'Investments', icon: BriefcaseBusiness },
  { id: 'timeline', label: 'Timeline', icon: Clock3 },
  { id: 'inbox', label: 'Inbox', icon: Mail },
  { id: 'reports', label: 'Reports', icon: ChartNoAxesCombined },
  { id: 'agents', label: 'Processing', icon: Bot },
  { id: 'connections', label: 'Connections', icon: Link2 },
] as const;
type Props = {
  view: View;
  family: string;
  onNavigate: (v: View) => void;
  onFamily: (s: string) => void;
  onSearch: () => void;
  onAsk: () => void;
  onSettings: () => void;
  title?: string;
  workspaceName?: string;
  inboxCount?: number;
  children: ReactNode;
};
function Navigation({
  view,
  family,
  onNavigate,
  onFamily,
  onSearch,
  onSettings,
  workspaceName,
  inboxCount = 0,
}: Omit<Props, 'children' | 'onAsk'>) {
  const { setOpenMobile } = useSidebar();
  const { state, data } = useWorkspace();
  const userName = state.identity?.user.name ?? 'Workspace member';
  const go = (v: View) => {
    onNavigate(v);
    setOpenMobile(false);
  };
  return (
    <Sidebar className="aster-sidebar">
      <SidebarHeader className="brand-area">
        <button
          className="brand"
          onClick={() => go('overview')}
          aria-label="Aster overview"
        >
          <Asterisk className="brand-symbol" />
          <span>Aster</span>
          <ChevronDown className="brand-chevron" />
        </button>
        <button className="search-trigger" onClick={onSearch}>
          <Search />
          <span>Search</span>
          <kbd>⌘ K</kbd>
        </button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navigation.map((n) => (
              <SidebarMenuItem key={n.id}>
                <SidebarMenuButton
                  isActive={view === n.id}
                  onClick={() => go(n.id)}
                  className="nav-item"
                >
                  <n.icon />
                  <span>{n.label}</span>
                  {n.id === 'inbox' ? (
                    <span className="nav-count">{inboxCount}</span>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <Separator className="sidebar-separator" />
        <SidebarGroup>
          <SidebarGroupLabel>Families</SidebarGroupLabel>
          <SidebarMenu>
            {data.families.map(({ id, name: label }) => (
              <SidebarMenuItem key={id}>
                <SidebarMenuButton
                  className="family-nav"
                  isActive={family === id}
                  onClick={() => {
                    onFamily(family === id ? 'all' : id);
                    setOpenMobile(false);
                  }}
                >
                  <span className="family-monogram">{label[0]}</span>
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="sidebar-bottom">
        <Separator />
        <div className="demo-label">
          <i />
          {state.sampleData ? 'Sample workspace' : 'Private workspace'}
        </div>
        <div className="profile-row">
          <span className="profile-avatar">
            {userName
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')}
          </span>
          <div>
            <strong>{userName}</strong>
            <small>
              {workspaceName ??
                state.identity?.organizationName ??
                state.officeName}
            </small>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Workspace settings"
            onClick={onSettings}
          >
            <Settings2 />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
function Topbar({
  view,
  onAsk,
  onSearch,
  title,
}: Pick<Props, 'view' | 'onAsk' | 'onSearch' | 'title'>) {
  const { toggleSidebar } = useSidebar();
  return (
    <header className="topbar">
      <div className="breadcrumb">
        <Button
          variant="ghost"
          size="icon"
          className="mobile-menu"
          onClick={toggleSidebar}
          aria-label="Open navigation"
        >
          <PanelLeft />
        </Button>
        <span>Workspace</span>
        <span className="slash">/</span>
        <span>{navigation.find((n) => n.id === view)?.label}</span>
        {title ? (
          <>
            <span className="slash">/</span>
            <strong>{title}</strong>
          </>
        ) : null}
      </div>
      <div className="topbar-actions">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search workspace"
          onClick={onSearch}
        >
          <Search />
        </Button>
        <Button variant="outline" className="ask-button" onClick={onAsk}>
          <Sparkles data-icon="inline-start" />
          Ask Aster
        </Button>
      </div>
    </header>
  );
}
export function Shell(props: Props) {
  const { state, data } = useWorkspace();
  const latest = data.holdings
    .map((h) => h.valuationDate)
    .sort()
    .at(-1);
  return (
    <SidebarProvider style={{ '--sidebar-width': '248px' } as CSSProperties}>
      <Navigation {...props} />
      <div className="app-main">
        <Topbar {...props} />
        <main className="workspace-content">{props.children}</main>
        <footer className="workspace-footer">
          <span>
            {state.sampleData ? 'Sample data' : 'Workspace records'}
            {latest
              ? ' · Latest mark ' + latest
              : ' · No portfolio records yet'}
          </span>
          <span>
            A clear view of what matters <ArrowUpRight />
          </span>
        </footer>
      </div>
    </SidebarProvider>
  );
}
