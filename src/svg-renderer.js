import _ from 'lodash';
import * as d3 from 'd3';

import svgUtil from './utils/svg-util';
import { GRAPH_EVENTS } from './graph-events';
import { flatten, traverse, removeChildren } from './utils';

const pathFn = svgUtil.pathFn.curve(d3.curveBasis);

// TODO
// - Add/Remove without relayout

/**
 * Base support for rendering and manipulating a compound/nested graph.
 *
 * 1. It setups a bare-bone rendering skeleton, In the sense that it renders empty group-nodes and move them
 * into their respective layout positions. It is up to the implementation class to provide the actual rendering
 * functions, which are:
 *
 * Basic rendering mode - redraws everything at every render-loop
 * - renderNode
 * - renderEdge
 *
 * Delta rendering mode - redraws added/removed/updated objects
 * - renderNodeAdded
 * - renderNodeUpdated
 * - renderNodeRemoved
 * - renderEdgeAdded
 * - renderEdgeUpdated
 * - renderEdgeRemoved
 *
 * Common/Misc
 * - renderEdgeControl
 *
 * The input specification consist of two things
 * - Graph data specified as a set of nodes and edges
 * - A configuration object to specify the rendering parameters
 *
 * The renderer itself is layout agnostic, it relies upon and expects a layout adapter to be
 * provided as a part of the configuration object. Moreover it expect the adapter to expose a
 * "run()" and "makeRenderingGraph()" methods.
 */
export default class SVGRenderer {
  /**
   * Create Elk graph renderer
   *
   * @param {HTMLElement} options.el - A container element that contains the rendered graph
   * @param {object} options - Renderer options
   * @param {object} options.adapter - Layout adapter
   * @param {string} options.renderMode - "basic" or "delta" modes. The basic mode provides new data-bindings
   *   every single render loop, where the deta mode provides added/updated/delete objects and allows you to
   *   handle them separately with different effects.
   * @param {boolean} options.useEdgeControl - Whether to use edge controls, default to false
   * @param {string} options.edgeControlOffsetType - "percentage" or "unit"
   * @param {numbeer} options.edgeControlOffset - If type is percentage this should be between 0 an 1,
   *   if unit then a positive value is an offset from the source, and a negative offset from the target.
   */
  constructor(options) {
    this.registry = new Map();
    this.options = options || {};
    this.options.renderMode = this.options.renderMode || 'basic';
    this.options.useEdgeControl = this.options.useEdgeControl || false;
    this.options.edgeControlOffsetType = this.options.edgeControlOffsetType || 'percentage';
    this.options.edgeControlOffset = this.options.edgeControlOffset || 0.66;
    this.options.useMinimap = this.options.useMinimap || false;
    this.options.addons = this.options.addons || [];

    // Primitive add-on system
    this.options.addons.forEach(addon => {
      addon(this).forEach(d => {
        this[d.name] = d.fn;
      });
    });

    this.adapter = this.options.adapter;

    this.svgEl = null;

    this.chart = null; // D3 chart reference
    this.chartSize = { width: 1, height: 1 };

    // The graph data + positions
    this.layout = null;

    if (options.el) {
      this.initialize(options.el);
    } else {
      throw new Error('options must provide an element for graph rendering');
    }

    // Internal trackers
    this.zoom = null;
  }

  setCallback(name, fn) {
    if (GRAPH_EVENTS.indexOf(name) === -1) {
      throw new Error(`Failed to register callback, unknown name ${name}`);
    } else {
      this.registry.set(name, fn);
    }
  }

  unsetCallback(name) {
    this.registry.delete(name);
  }

  /**
   * Initialize the renderer with given container element
   * @param {HTMLElement} element - container element
   */
  initialize(element) {
    this.chartSize.width = element.clientWidth;
    this.chartSize.height = element.clientHeight;

    this.svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    removeChildren(element).appendChild(this.svgEl);
    this.svgEl.style.userSelect = 'none';
  }

  /**
   * Set graph data
   * @param {Object} data - a graph model data
   */
  setData(data) {
    this.layout = this.adapter.makeRenderingGraph(data);
  }

  getBoundary() {
    const t = d3.zoomTransform(this.chart.node());
    const x1 = (0 - t.x) / t.k;
    const y1 = (0 - t.y) / t.k;
    const x2 = (this.chartSize.width) / t.k;
    const y2 = (this.chartSize.height) / t.k;
    return { x1, y1, x2, y2 };
  }

  /**
   * Renders the graph
   */
  async render() {
    const options = this.options;
    if (!this.layout) {
      throw new Error('Layout data not set');
    }
    this.layout = await this.adapter.run(this.layout);

    // Addresses the case where swapping layout introduce sufficient changes that
    // we need to recalculate the viewport dimensions
    if (!this.chart) {
      this.chart = this._createChart();
    } else {
      // Reset zoom
      const svg = d3.select(this.svgEl);
      svg.transition().call(
        this.zoom.transform,
        d3.zoomIdentity
      );
      const maxZoom = Math.max(2, Math.floor(this.layout.width / this.chartSize.width));
      this.zoom.scaleExtent([0.5, maxZoom]);
    }

    this.buildDefs();

    if (options.renderMode === 'basic') {
      this.renderNodes();
      this.renderEdges();
    } else {
      this.renderNodesDelta();
      this.renderEdgesDelta();
    }

    if (options.useEdgeControl) {
      this.renderEdgeControls();
    }
    this._enableInteraction();

    if (options.useMinimap === true) {
      this.renderMinimap();
    }
  }

  renderMinimap() {
    const minimapHeight = 0.125 * this.chartSize.height;
    const minimap = d3.select(this.svgEl).select('.foreground-layer').append('g').classed('minimap', true);
    const miniMapZoomLevel = 1 / (this.layout.height / minimapHeight);
    minimap.attr('transform', `translate(20, 10), scale(${miniMapZoomLevel})`);

    const topNodes = this.layout.nodes;
    for (let i = 0; i < topNodes.length; i++) {
      const node = topNodes[i];
      minimap.append('rect')
        .attr('x', node.x)
        .attr('y', node.y)
        .attr('width', node.width)
        .attr('height', node.height)
        .attr('fill', '#CCC');
    }
    const { x1, y1, x2, y2 } = this.getBoundary();
    minimap.append('rect')
      .attr('x', x1)
      .attr('y', y1)
      .attr('width', x2)
      .attr('height', y2)
      .attr('stroke', '#000')
      .attr('stroke-width', 2)
      .attr('fill', 'transparent');
  }

  // FIXME: Should provide very basic marker definitions and leave the work to the
  // implementation renderers
  buildDefs() {
    const svg = d3.select(this.svgEl);
    const edges = flatten(this.layout).edges;

    // Clean up
    svg.select('defs').selectAll('.edge-marker-end').remove();

    svg.select('defs')
      .selectAll('.edge-marker-end')
      .data(edges)
      .enter()
      .append('marker')
      .classed('edge-marker-end', true)
      .attr('id', d => {
        const source = d.source.replace(/\s/g, '');
        const target = d.target.replace(/\s/g, '');
        return `arrowhead-${source}-${target}`;
      })
      .attr('viewBox', svgUtil.MARKER_VIEWBOX)
      .attr('refX', 2)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 15)
      .attr('markerHeight', 15)
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('xoverflow', 'visible')
      .append('svg:path')
      .attr('d', svgUtil.ARROW)
      .style('fill', '#000')
      .style('stroke', 'none');
  }


  /**
   * A fancier version of renderEdges, figure out the delta between
   * different layout runs and provide access to added, updated, and
   * removed graph elements.
   */
  renderEdgesDelta() {
    const chart = this.chart;
    let allEdges = [];

    traverse(this.layout, (node) => {
      if (node.edges && node.edges.length > 0) {
        allEdges = allEdges.concat(node.edges);
      }
    });

    const edgesGroup = chart.selectAll('.edge').data(allEdges, d => d.id);

    // Scaffold added/updated/removed
    const newEdges = edgesGroup.enter().append('g').classed('edge', true);

    edgesGroup.exit().each(d => (d.state = 'removed'));
    newEdges.each(d => (d.state = 'new'));
    edgesGroup.each(d => (d.state = 'updated'));

    // Rebind because children point to different reference
    chart.selectAll('.edge').filter(d => d.state === 'updated').each(function(d) {
      d3.select(this).selectAll('.edge-path').datum(d);
    });

    chart.selectAll('.edge').filter(d => d.state === 'new').call(this.renderEdgeAdded);
    chart.selectAll('.edge').filter(d => d.state === 'updated').call(this.renderEdgeUpdated);
    chart.selectAll('.edge').filter(d => d.state === 'removed').call(this.renderEdgeRemoved);
  }

  renderEdges() {
    const chart = this.chart;
    chart.selectAll('.edge').remove();

    const _recursiveBuild = (n) => {
      if (n.nodes) {
        n.nodes.forEach(node => {
          _recursiveBuild(node);
        });
      }
      if (!n.edges) return;

      chart.selectAll('.edge')
        .data(n.edges, d => d.id)
        .enter().append('g')
        .classed('edge', true);
    };
    _recursiveBuild(this.layout);
    chart.selectAll('.edge').call(this.renderEdge);
  }

  /**
   * A fancier version of renderNodes, figures out the delta between
   * different layout runs and provide access to added, updated, and
   * removed graph elements.
   */
  renderNodesDelta() {
    const chart = this.chart;

    const _recursiveBuild = (selection, childrenNodes) => {
      if (!childrenNodes) return;

      const nodesGroup = selection.selectAll('.node').filter(function() {
        return this.parentNode === selection.node();
      }).data(childrenNodes, d => d.id);

      const newNodes = nodesGroup.enter().append('g')
        .classed('node', true);

      // nodesGroup.exit().remove();
      nodesGroup.exit().each(d => (d.state = 'removed'));
      newNodes.each(d => (d.state = 'new'));
      nodesGroup.each(d => (d.state = 'updated'));

      [newNodes, nodesGroup].forEach(g => {
        g.each(function(d) {
          const selection = d3.select(this);

          // Allocate for the node itself
          if (selection.select('.node-ui').size() === 0) {
            selection.append('g').classed('node-ui', true);
          }
          selection.select('.node-ui').datum(d);

          // Allocate for the node's children
          if (selection.select('.node-children').size() === 0) {
            selection.append('g').classed('node-children', true);
          }
          _recursiveBuild(selection.select('.node-children'), d.nodes);
        });

        g.transition().duration(1000).attr('transform', d => {
          return svgUtil.translate(d.x, d.y);
        });
      });
    };
    _recursiveBuild(chart, this.layout.nodes);

    chart.selectAll('.node-ui').filter(d => d.state === 'new').call(this.renderNodeAdded);
    chart.selectAll('.node-ui').filter(d => d.state === 'updated').call(this.renderNodeUpdated);
    chart.selectAll('.node-ui').filter(d => d.state === 'removed').call(this.renderNodeRemoved);
  }

  /**
   * Simple basic renderNodes, just wipe out all nodes and redraw
   */
  renderNodes() {
    const chart = this.chart;
    chart.selectAll('.node').remove();

    const _recursiveBuild = (selection, childrenNodes) => {
      if (!childrenNodes) return;
      const nodesGroup = selection.selectAll('.node')
        .data(childrenNodes)
        .enter().append('g')
        .classed('node', true)
        .attr('transform', d => {
          return svgUtil.translate(d.x, d.y);
        });

      nodesGroup.each(function(d) {
        const s = d3.select(this);
        s.append('g').classed('node-ui', true);
        _recursiveBuild(s.append('g'), d.nodes);
      });
    };
    _recursiveBuild(chart, this.layout.nodes);
    chart.selectAll('.node-ui').call(this.renderNode);
  }

  calculateEdgeControlPlacement(pathNode) {
    const options = this.options;
    let pos = 0;
    const total = pathNode.getTotalLength();
    const offset = options.edgeControlOffset;
    if (options.edgeControlOffsetType === 'percentage') {
      pos = offset * total;
    } else {
      pos = offset > 0 ? offset : Math.max(0, (total + offset));
    }
    const controlPoint = pathNode.getPointAtLength(pos);
    return controlPoint;
  }

  /**
   * Renders a controller UI element along the edge path
   */
  renderEdgeControls() {
    const chart = this.chart;
    const edges = chart.selectAll('.edge');
    edges.selectAll('.edge-control').remove();

    const self = this;

    edges.each(function() {
      const pathNode = d3.select(this).select('path').node();
      const controlPoint = self.calculateEdgeControlPlacement(pathNode);
      d3.select(this).append('g')
        .classed('edge-control', true)
        .attr('transform', svgUtil.translate(controlPoint.x, controlPoint.y));
    });
    chart.selectAll('.edge-control').call(this.renderEdgeControl);
  }

  /**
   * Prepare the SVG and returns a chart refrence. This function will create three "layers": background,
   * data, and foreground layers. The data-layer corresponds to the chart.
   */
  _createChart() {
    const { width, height } = this.chartSize;
    const svg = d3.select(this.svgEl);
    svg.selectAll('*').remove();

    const treatedSVG = svgUtil.createChart(svg, width, height);

    // Add a debugging/background layer
    treatedSVG.append('g').classed('background-layer', true);

    // Add chart group
    const chart = treatedSVG.append('g').classed('data-layer', true);

    // Add a foreground layer
    const foreground = treatedSVG.append('g').classed('foreground-layer', true); // eslint-disable-line
    return chart;
  }

  /**
   * Standard interaction hooks, these are essentially callback functions
   * that takes in two parameters: A d3 selection of the element, and a
   * reference to the renderer.
   */
  _enableInteraction() {
    const chart = this.chart;
    const self = this;
    const registry = this.registry;
    const svg = d3.select(this.svgEl);
    const nodes = chart.selectAll('.node');
    const edges = chart.selectAll('.edge');
    self.clickTimer = null;

    svg.on('click', function (evt) {
      evt.stopPropagation();
      const pointerCoords = d3.zoomTransform(svg.node()).invert(d3.pointer(evt));
      if (registry.has('backgroundClick')) {
        registry.get('backgroundClick')(evt, d3.select(this), self, {
          x: pointerCoords[0],
          y: pointerCoords[1]
        });
      }
    });

    svg.on('dblclick', function (evt) {
      evt.stopPropagation();
      const pointerCoords = d3.zoomTransform(svg.node()).invert(d3.pointer(evt));
      if (registry.has('backgroundDblClick')) {
        registry.get('backgroundDblClick')(evt, d3.select(this), self, {
          x: pointerCoords[0],
          y: pointerCoords[1]
        });
      }
    });

    nodes.on('dblclick', function(evt) {
      evt.stopPropagation();
      if (registry.has('nodeDblClick')) {
        window.clearTimeout(self.clickTimer);
        registry.get('nodeDblClick')(evt, d3.select(this), self);
      }
    });

    nodes.on('click', function(evt) {
      evt.stopPropagation();
      if (registry.has('nodeClick')) {
        const _this = this;
        window.clearTimeout(self.clickTimer);
        self.clickTimer = window.setTimeout(() => {
          registry.get('nodeClick')(evt, d3.select(_this), self);
        }, 200);
      }
    });

    nodes.on('mouseenter', function(evt) {
      evt.stopPropagation();
      if (registry.has('nodeMouseEnter')) { registry.get('nodeMouseEnter')(evt, d3.select(this), self); }
    });

    nodes.on('mouseleave', function(evt) {
      evt.stopPropagation();
      if (registry.has('nodeMouseLeave')) { registry.get('nodeMouseLeave')(evt, d3.select(this), self); }
    });

    edges.on('click', function(evt) {
      evt.stopPropagation();
      if (registry.has('edgeClick')) { registry.get('edgeClick')(evt, d3.select(this), self); }
    });

    edges.on('mouseenter', function(evt) {
      evt.stopPropagation();
      if (registry.has('edgeMouseEnter')) { registry.get('edgeMouseEnter')(evt, d3.select(this), self); }
    });

    edges.on('mouseleave', function(evt) {
      evt.stopPropagation();
      if (registry.has('edgeMouseLeave')) { registry.get('edgeMouseLeave')(evt, d3.select(this), self); }
    });


    // Zoom control
    function zoomed(evt) {
      chart.attr('transform', evt.transform);
    }
    function zoomEnd() {
      if (!self.layout) return;
      if (self.options.useMinimap === false) return;
      const { x1, y1, x2, y2 } = self.getBoundary();
      const minimap = d3.select(self.svgEl).select('.foreground-layer').select('.minimap');
      minimap.select('.current-view').remove();
      minimap.append('rect')
        .classed('current-view', true)
        .attr('x', x1)
        .attr('y', y1)
        .attr('width', x2)
        .attr('height', y2)
        .attr('stroke', '#000')
        .attr('stroke-width', 1)
        .attr('fill', '#369')
        .attr('fill-opacity', 0.1);
    }

    const minZoom = 0.05;
    const maxZoom = Math.max(2, Math.floor(this.layout.width / this.chartSize.width));
    const zoomLevel = Math.min(1, 1 / (this.layout.height / this.chartSize.height));
    this.zoom = d3.zoom().scaleExtent([minZoom, maxZoom]).on('zoom', zoomed).on('end', zoomEnd);
    svg.call(this.zoom).on('dblclick.zoom', null);

    svg.call(
      this.zoom.transform,
      d3.zoomIdentity.translate(0, 0).scale(zoomLevel).translate(
        (-(this.layout.width * zoomLevel * 0.5) + 0.5 * this.chartSize.width) / zoomLevel,
        (-(this.layout.height * zoomLevel * 0.5) + 0.5 * this.chartSize.height) / zoomLevel
      )
    );
  }

  // FIXME: used in nodeDrag, a bit awkward
  updateEdgePoints() {
    const chart = this.chart;
    const options = this.options;
    const self = this;
    chart.selectAll('.edge').selectAll('path').attr('d', d => {
      return pathFn(d.points);
    });
    if (options.useEdgeControl) {
      chart.selectAll('.edge').each(function() {
        const pathNode = d3.select(this).select('path').node();
        const controlPoint = self.calculateEdgeControlPlacement(pathNode);
        d3.select(this).select('.edge-control')
          .attr('transform', svgUtil.translate(controlPoint.x, controlPoint.y));
      });
    }
  }

  /**
   * Given a node identifier, trace up the ancestor chain and record edges along the way
   *
   * @param {string} id - node identifier
   */
  trace(nodeId) {
    const checked = new Map();
    const data = this.layout || { edges: [] };
    const tracedEdges = [];

    function backtrack(id) {
      if (checked.has(id)) return;
      checked.set(id, 1);

      const edges = data.edges.filter(edge => edge.target === id);
      edges.forEach(edge => {
        tracedEdges.push(edge);
        backtrack(edge.source);
      });
    }
    backtrack(nodeId, [nodeId]);

    return {
      edges: tracedEdges.map(edge => {
        return { source: edge.source, target: edge.target };
      }),
      nodes: _.uniq([...tracedEdges.map(e => e.source), ...tracedEdges.map(e => e.target)])
    };
  }
}
