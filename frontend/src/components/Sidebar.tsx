import { useState, useEffect } from 'react'
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  Typography,
} from '@mui/material'
import CloudIcon from '@mui/icons-material/Cloud'
import PublicIcon from '@mui/icons-material/Public'
import CloudQueueIcon from '@mui/icons-material/CloudQueue'
import AppsRoundedIcon from '@mui/icons-material/AppsRounded'
import MemoryIcon from '@mui/icons-material/Memory'
import HubIcon from '@mui/icons-material/Hub'
import VpnKeyIcon from '@mui/icons-material/VpnKey'
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined'
import AttachMoneyIcon from '@mui/icons-material/AttachMoney'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import GroupWorkIcon from '@mui/icons-material/GroupWork'
import BusinessIcon from '@mui/icons-material/Business'
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline'
import GroupsIcon from '@mui/icons-material/Groups'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import MailOutlineIcon from '@mui/icons-material/MailOutline'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch'
import SettingsIcon from '@mui/icons-material/Settings'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FindInPageIcon from '@mui/icons-material/FindInPage'
import LayersIcon from '@mui/icons-material/Layers'
import SpeedIcon from '@mui/icons-material/Speed'
import LanguageIcon from '@mui/icons-material/Language'

// -----------------------------------------------------------------------------
// Nav-tree model. Kept declarative so the render below is a straightforward
// map. Every leaf owns a stable `path` that AppShell reads/writes into the URL
// hash — no router package needed.
// -----------------------------------------------------------------------------

type LeafNode = {
  kind: 'leaf'
  label: string
  path: string
  Icon: typeof CloudIcon
}

type ParentNode = {
  kind: 'parent'
  label: string
  path: string // clickable parent (e.g. infra/azure) — else use ''
  Icon: typeof CloudIcon
  children: NavNode[]
}

type NavNode = LeafNode | ParentNode

const TREE: NavNode[] = [
  {
    kind: 'parent',
    label: 'Infra',
    path: '',
    Icon: CloudIcon,
    children: [
      {
        kind: 'parent',
        label: 'AWS',
        path: '',
        Icon: PublicIcon,
        children: [
          {
            kind: 'leaf',
            label: 'Services',
            path: 'infra/aws/services',
            Icon: AppsRoundedIcon,
          },
          {
            kind: 'leaf',
            label: 'Compute',
            path: 'infra/aws/compute',
            Icon: MemoryIcon,
          },
          {
            kind: 'leaf',
            label: 'Clusters',
            path: 'infra/aws/clusters',
            Icon: HubIcon,
          },
          {
            kind: 'leaf',
            label: 'Access',
            path: 'infra/aws/access',
            Icon: VpnKeyIcon,
          },
        ],
      },
      {
        // Azure is a leaf (clicking it renders the coming-soon panel).
        kind: 'leaf',
        label: 'Azure',
        path: 'infra/azure',
        Icon: CloudQueueIcon,
      },
    ],
  },
  {
    kind: 'parent',
    label: 'Platform',
    path: '',
    Icon: DashboardOutlinedIcon,
    children: [
      {
        kind: 'leaf',
        label: 'Cost',
        path: 'platform/cost',
        Icon: AttachMoneyIcon,
      },
      {
        kind: 'leaf',
        label: 'Billing & Metering',
        path: 'platform/billing',
        Icon: ReceiptLongIcon,
      },
      {
        kind: 'leaf',
        label: 'Releases',
        path: 'platform/releases',
        Icon: RocketLaunchIcon,
      },
      {
        kind: 'leaf',
        label: 'Agents',
        path: 'platform/agents',
        Icon: SmartToyIcon,
      },
      {
        kind: 'leaf',
        label: 'Audit',
        path: 'platform/audit',
        Icon: FindInPageIcon,
      },
      {
        kind: 'leaf',
        label: 'kpack',
        path: 'platform/kpack',
        Icon: LayersIcon,
      },
      {
        kind: 'leaf',
        label: 'Limits',
        path: 'platform/limits',
        Icon: SpeedIcon,
      },
      {
        kind: 'leaf',
        label: 'Domains',
        path: 'platform/domains',
        Icon: LanguageIcon,
      },
      {
        kind: 'parent',
        label: 'Directory',
        path: '',
        Icon: GroupWorkIcon,
        children: [
          {
            kind: 'leaf',
            label: 'Orgs',
            path: 'platform/directory/orgs',
            Icon: BusinessIcon,
          },
          {
            kind: 'leaf',
            label: 'Users',
            path: 'platform/directory/users',
            Icon: PeopleOutlineIcon,
          },
          {
            kind: 'leaf',
            label: 'Groups',
            path: 'platform/directory/groups',
            Icon: GroupsIcon,
          },
          {
            kind: 'leaf',
            label: 'Roles',
            path: 'platform/directory/roles',
            Icon: AdminPanelSettingsIcon,
          },
          {
            kind: 'leaf',
            label: 'Invitations',
            path: 'platform/directory/invitations',
            Icon: MailOutlineIcon,
          },
        ],
      },
      {
        kind: 'leaf',
        label: 'Administration',
        path: 'platform/administration',
        Icon: SettingsIcon,
      },
      {
        kind: 'leaf',
        label: 'Docs',
        path: 'platform/docs',
        Icon: MenuBookIcon,
      },
    ],
  },
]

// -----------------------------------------------------------------------------
// Accordion-open-state persistence
// -----------------------------------------------------------------------------

const STORAGE_KEY = 'adminNav.expanded'
const DEFAULT_EXPANDED: Record<string, boolean> = {
  Infra: true,
  AWS: true,
  Platform: true,
  Directory: true,
  Azure: false,
}

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_EXPANDED }
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return { ...DEFAULT_EXPANDED, ...parsed }
  } catch {
    return { ...DEFAULT_EXPANDED }
  }
}

function saveExpanded(state: Record<string, boolean>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // sessionStorage may be disabled (private mode) — silently no-op.
  }
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface SidebarProps {
  selectedPath: string
  onSelect: (path: string) => void
}

// Deep-links like `platform/agents/some-agent` should still light up the
// `platform/agents` leaf as active.
function isPathActive(leafPath: string, selectedPath: string): boolean {
  if (!leafPath) return false
  if (leafPath === selectedPath) return true
  return selectedPath.startsWith(leafPath + '/')
}

export default function Sidebar({ selectedPath, onSelect }: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpanded())

  useEffect(() => {
    saveExpanded(expanded)
  }, [expanded])

  const toggle = (label: string) => {
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }))
  }

  // Render depth-aware for correct indentation. Top-level = 0, nested = 1, 2…
  const renderNode = (node: NavNode, depth: number): JSX.Element => {
    if (node.kind === 'leaf') {
      const active = isPathActive(node.path, selectedPath)
      const LeafIcon = node.Icon
      return (
        <ListItemButton
          key={node.path}
          onClick={() => onSelect(node.path)}
          selected={active}
          sx={{
            pl: 2 + depth * 2,
            py: 0.75,
            borderLeft: '3px solid',
            borderLeftColor: active ? 'primary.main' : 'transparent',
            color: active ? '#fff' : 'rgba(255,255,255,0.72)',
            bgcolor: active ? 'rgba(255,255,255,0.06)' : 'transparent',
            '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
            '&.Mui-selected': {
              bgcolor: 'rgba(255,255,255,0.08)',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.10)' },
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 32,
              color: active ? 'primary.light' : 'rgba(255,255,255,0.55)',
            }}
          >
            <LeafIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={node.label}
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: active ? 600 : 500,
            }}
          />
        </ListItemButton>
      )
    }

    // Parent (accordion).
    const ParentIcon = node.Icon
    const isOpen = expanded[node.label] ?? true
    return (
      <Box key={node.label}>
        <ListItemButton
          onClick={() => toggle(node.label)}
          sx={{
            pl: 2 + depth * 2,
            py: 0.75,
            color: 'rgba(255,255,255,0.85)',
            '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
          }}
        >
          <ListItemIcon
            sx={{ minWidth: 32, color: 'rgba(255,255,255,0.75)' }}
          >
            <ParentIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={node.label}
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          />
          {isOpen ? (
            <ExpandLessIcon fontSize="small" sx={{ color: 'rgba(255,255,255,0.55)' }} />
          ) : (
            <ExpandMoreIcon fontSize="small" sx={{ color: 'rgba(255,255,255,0.55)' }} />
          )}
        </ListItemButton>
        <Collapse in={isOpen} timeout="auto" unmountOnExit>
          <List component="div" disablePadding>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </List>
        </Collapse>
      </Box>
    )
  }

  return (
    <Box
      component="nav"
      sx={{
        width: 240,
        flexShrink: 0,
        position: 'sticky',
        top: 64, // AppBar height
        alignSelf: 'flex-start',
        height: 'calc(100vh - 64px)',
        overflowY: 'auto',
        bgcolor: '#0f172a',
        color: '#fff',
        borderRight: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Typography
          variant="caption"
          sx={{
            color: 'rgba(255,255,255,0.5)',
            fontSize: '0.65rem',
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          NAVIGATION
        </Typography>
      </Box>
      <List component="div" sx={{ pt: 0 }}>
        {TREE.map((node) => renderNode(node, 0))}
      </List>
    </Box>
  )
}
