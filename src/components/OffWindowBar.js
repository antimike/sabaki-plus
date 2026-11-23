import {h} from 'preact'

import i18n from '../i18n.js'

const t = i18n.context('OffWindowBar')

// Fork (baduk mcms): the candidates a cropped board cannot show, a frame ko
// threat and a pass, as one line under the board, listed whenever the engine
// reports them, like heatmap cells. The one with the most visits of all
// candidates is highlighted, as the heatmap's strongest cell stands out.
export default function OffWindowBar({entries}) {
  let labels = {
    koThreat: t('Ko threat'),
    tenuki: t('Tenuki'),
  }

  return h(
    'div',
    {id: 'offwindow'},
    entries.map(({kind, visits, winrate, scoreLead, best}) =>
      h(
        'span',
        {
          key: kind,
          class: best ? `entry ${kind} best` : `entry ${kind}`,
          title: t(
            ({visits}) =>
              `Engine candidate outside the window: ${visits} visits`,
            {visits: i18n.formatNumber(visits)},
          ),
        },
        [
          labels[kind],
          i18n.formatNumber(Math.round(winrate * 10) / 10) + '%',
          scoreLead == null
            ? null
            : (scoreLead >= 0 ? '+' : '') +
              i18n.formatNumber(Math.round(scoreLead * 10) / 10),
        ]
          .filter((x) => x != null)
          .join(' · '),
      ),
    ),
  )
}
