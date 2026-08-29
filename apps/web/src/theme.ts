import { theme, type ThemeConfig } from 'antd';

export const antdTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#F7931A',
    colorInfo: '#2E90FA',
    colorSuccess: '#0ECB81',
    colorError: '#F6465D',
    colorWarning: '#E8A33D',
    colorBgBase: '#0B0E14',
    colorBgContainer: '#141922',
    colorBgElevated: '#1C2430',
    colorText: '#F5F7FA',
    colorTextSecondary: '#A7B1C2',
    colorTextTertiary: '#6B7688',
    colorBorder: 'rgba(255,255,255,0.10)',
    colorBorderSecondary: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    fontSize: 13,
    fontFamily:
      "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica Neue, Arial, sans-serif",
    wireframe: false,
  },
  components: {
    Card: { paddingLG: 18, borderRadiusLG: 16 },
    Table: { headerBg: 'rgba(255,255,255,0.03)', rowHoverBg: 'rgba(247,147,26,0.06)' },
    Statistic: { titleFontSize: 12, contentFontSize: 24 },
    Tag: { defaultBg: 'rgba(255,255,255,0.06)', defaultColor: '#A7B1C2' },
    Tabs: { itemSelectedColor: '#F7931A', inkBarColor: '#F7931A' },
    Switch: { colorPrimary: '#0ECB81' },
    Progress: { defaultColor: '#F7931A' },
    Drawer: { colorBgElevated: '#0F131B' },
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(247,147,26,0.16)',
      darkItemSelectedColor: '#FFB020',
      darkItemHoverBg: 'rgba(255,255,255,0.05)',
      itemBorderRadius: 10,
    },
  },
};
