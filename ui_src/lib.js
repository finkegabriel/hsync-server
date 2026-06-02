import { h, Component, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import apiFetch from './api-fetch.js';
import debug from 'debug';
import config from '../config.js';
import { defaultConfig, p2pConfig } from '../index.js';

const html = htm.bind(h);

window.hsyncConfig.libs = {
  preact: {
    h,
    Component,
    render,
    useState,
    useEffect,
    html,
  },
  htm,
  apiFetch,
  debug,
};

window.libp2p = {
    p2pAddress: p2pConfig.p2pAddress,
};
