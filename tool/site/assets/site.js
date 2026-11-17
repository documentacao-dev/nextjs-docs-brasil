// Interações do site: tema, abas de código (TS/JS e gerenciador de pacotes),
// copiar, seletor de router, menu no celular, busca (Pagefind) e sumário ativo.
// Nada sai do navegador: as preferências ficam no localStorage.
(function () {
  var raiz = document.documentElement;
  function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function gravar(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // tema
  document.querySelectorAll('[data-tema]').forEach(function (b) {
    b.addEventListener('click', function () {
      var escuro = raiz.classList.toggle('escuro');
      gravar('tema', escuro ? 'escuro' : 'claro');
    });
  });

  // abas de código
  function aplicar(grupo, valor) {
    document.querySelectorAll('.grupo[data-grupo="' + grupo + '"]').forEach(function (g) {
      var tem = g.querySelector('.painel[data-valor="' + valor + '"]');
      if (!tem) return;
      g.querySelectorAll('.aba').forEach(function (a) { a.setAttribute('aria-selected', a.dataset.valor === valor ? 'true' : 'false'); });
      g.querySelectorAll('.painel').forEach(function (p) { p.hidden = p.dataset.valor !== valor; });
    });
  }
  ['pm', 'linguagem'].forEach(function (g) { var v = ler('aba-' + g); if (v) aplicar(g, v); });
  document.addEventListener('click', function (ev) {
    var aba = ev.target.closest('.aba');
    if (aba) {
      var grupo = aba.closest('.grupo').dataset.grupo;
      var topo = aba.getBoundingClientRect().top;
      aplicar(grupo, aba.dataset.valor);
      gravar('aba-' + grupo, aba.dataset.valor);
      window.scrollBy(0, aba.getBoundingClientRect().top - topo); // não pula a página
      return;
    }
    var copiar = ev.target.closest('.copiar');
    if (copiar) {
      var pre = copiar.parentNode.querySelector('pre');
      navigator.clipboard.writeText(pre ? pre.innerText : '').then(function () {
        copiar.textContent = 'Copiado';
        setTimeout(function () { copiar.textContent = 'Copiar'; }, 1500);
      });
    }
  });

  // seletor de router
  var lateral = document.getElementById('lateral');
  var seletor = document.querySelector('[data-seletor-router]');
  if (lateral && seletor) {
    if (lateral.dataset.compartilhada === 'true') {
      var pref = ler('router');
      if (pref) seletor.value = pref;
    } else {
      gravar('router', seletor.value);
    }
    seletor.addEventListener('change', function () {
      gravar('router', seletor.value);
      if (lateral.dataset.compartilhada === 'true') {
        raiz.dataset.router = seletor.value;
      } else {
        location.href = lateral.dataset['destino' + (seletor.value === 'app' ? 'App' : 'Pages')];
      }
    });
  }

  // menu no celular
  var menu = document.querySelector('.botao-menu');
  if (menu) {
    menu.addEventListener('click', function () {
      var aberto = document.body.classList.toggle('menu-aberto');
      menu.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    });
  }

  // item atual visível na barra lateral
  var atual = document.querySelector('.arvore a[aria-current="page"]');
  if (atual && lateral) {
    var r = atual.getBoundingClientRect();
    if (r.top > window.innerHeight - 100) lateral.scrollTop = r.top - window.innerHeight / 2;
  }

  // busca
  var dialogo = document.getElementById('busca');
  var carregada = false;
  function abrirBusca() {
    if (!dialogo) return;
    if (!carregada) {
      carregada = true;
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/pagefind/pagefind-ui.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = '/pagefind/pagefind-ui.js';
      s.onload = function () {
        new PagefindUI({ element: '#busca-ui', showSubResults: true, showImages: false, resetStyles: false, autofocus: true });
        var input = dialogo.querySelector('input');
        if (input) input.focus();
      };
      document.head.appendChild(s);
    }
    dialogo.showModal();
    var input = dialogo.querySelector('input');
    if (input) input.focus();
  }
  document.querySelectorAll('[data-abrir-busca]').forEach(function (b) { b.addEventListener('click', abrirBusca); });
  document.querySelectorAll('[data-fechar-busca]').forEach(function (b) { b.addEventListener('click', function () { dialogo.close(); }); });
  if (dialogo) dialogo.addEventListener('click', function (ev) { if (ev.target === dialogo) dialogo.close(); });
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); abrirBusca(); }
    else if (ev.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { ev.preventDefault(); abrirBusca(); }
  });

  // sumário: destaca o título visível
  var links = document.querySelectorAll('.toc a');
  if (links.length && 'IntersectionObserver' in window) {
    var mapa = {};
    links.forEach(function (a) { mapa[decodeURIComponent(a.hash.slice(1))] = a; });
    var obs = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (e.isIntersecting && mapa[e.target.id]) {
          links.forEach(function (a) { a.classList.remove('ativo'); });
          mapa[e.target.id].classList.add('ativo');
        }
      });
    }, { rootMargin: '-70px 0px -70% 0px' });
    Object.keys(mapa).forEach(function (id) { var el = document.getElementById(id); if (el) obs.observe(el); });
  }
})();
