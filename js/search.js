/**
 * 网址导航 - 搜索功能脚本
 * 功能: 搜索引擎分类切换、搜索表单提交
 * 修复: 初始化时 input:checked 可能为 null 导致崩溃的问题
 */

document.addEventListener('DOMContentLoaded', function () {
  // ==================== 搜索引擎分类切换 ====================
  document.querySelectorAll('.search-category').forEach(label => {
    label.addEventListener('click', function () {
      document.querySelectorAll('.search-category').forEach(item => item.classList.remove('active'));
      this.classList.add('active');

      const groupId = this.getAttribute('data-id');
      document.querySelectorAll('.search-group').forEach(group => {
        group.classList.remove('active');
      });

      // 安全查询目标分组
      const targetGroup = document.querySelector(`.search-group.${groupId}`);
      if (targetGroup) {
        targetGroup.classList.add('active');

        // 切换分组后自动激活该分组中第一个选中的引擎，若无则激活第一个
        const activeRadio = targetGroup.querySelector('input:checked') ||
                            targetGroup.querySelector('input');
        if (activeRadio) {
          activeRadio.checked = true;
          activeRadio.dispatchEvent(new Event('change'));
        }
      }
    });
  });

  // ==================== 搜索引擎单选切换 ====================
  document.querySelectorAll('.search-type input').forEach(radio => {
    radio.addEventListener('change', function () {
      const form = document.getElementById('search-form');
      if (form) form.action = this.value;

      const placeholder = this.getAttribute('data-placeholder');
      const searchInput = document.getElementById('search-text');
      if (searchInput) {
        searchInput.placeholder = placeholder || '请输入搜索内容';
      }

      // 更新 label 激活状态
      document.querySelectorAll('.search-type label').forEach(label => label.classList.remove('active'));
      const parentLi = this.closest('li');
      if (parentLi) {
        const label = parentLi.querySelector('label');
        if (label) label.classList.add('active');
      }
    });
  });

  // ==================== 搜索表单提交 ====================
  const searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', function (event) {
      event.preventDefault();

      const searchInput = document.getElementById('search-text');
      const searchText = searchInput ? searchInput.value.trim() : '';
      const actionUrl = this.action;

      if (searchText) {
        window.open(`${actionUrl}${encodeURIComponent(searchText)}`, '_blank', 'noopener');
      } else {
        // 输入为空时聚焦并轻微抖动提示，替代 alert
        if (searchInput) {
          searchInput.focus();
          searchInput.classList.add('shake');
          setTimeout(() => searchInput.classList.remove('shake'), 500);
        }
      }
    });
  }

  // ==================== 初始化 ====================
  // 激活默认分类（安全调用，防止 .active 不存在时报错）
  const activeCategory = document.querySelector('.search-category.active') ||
                         document.querySelector('.search-category');
  if (activeCategory) {
    activeCategory.click();
  }

  // 激活默认搜索引擎
  // 修复：原代码直接查询 input:checked，但 HTML 中无 checked 属性会导致 null.dispatchEvent 崩溃
  const checkedRadio = document.querySelector('.search-type input:checked');
  const firstRadioInActiveGroup = document.querySelector('.search-group.active .search-type input');
  const radioToActivate = checkedRadio || firstRadioInActiveGroup;

  if (radioToActivate) {
    radioToActivate.checked = true;
    radioToActivate.dispatchEvent(new Event('change'));
  }
});
