/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import Page from '@/pages/page';
// import lottieLoader from '@lib/rlottie/lottieLoader';
import {horizontalMenu} from '@components/horizontalMenu';
import {MOUNT_CLASS_TO} from '@config/debug';

class PagesManager {
  private pageId = -1;
  private page: Page;

  private selectTab: ReturnType<typeof horizontalMenu>;
  public pagesDiv: HTMLDivElement;
  public scrollableDiv: HTMLElement;

  constructor() {
    this.pagesDiv = document.getElementById('auth-pages') as HTMLDivElement;
    this.scrollableDiv = this.pagesDiv.querySelector('.scrollable') as HTMLElement;
    this.selectTab = horizontalMenu(null, this.scrollableDiv.querySelector('.tabs-container') as HTMLDivElement, null, () => {
      if(this.page?.onShown) {
        this.page.onShown();
      }
    });
  }

  public setPage(page: Page) {
    if(page.isAuthPage) {
      this.pagesDiv.style.display = '';
      import('./nostra-onboarding-integration').then((m) => {
        m.mountNostraOnboarding(
          this.pagesDiv.querySelector('.scrollable') ?? this.pagesDiv
        );
      });
      return;
    } else {
      this.pagesDiv.style.display = 'none';
      page.pageEl.style.display = '';

      this.pageId = -1;
    }

    this.page = page;
  }
}

const pagesManager = new PagesManager();
MOUNT_CLASS_TO.pagesManager = pagesManager;
export default pagesManager;
